/**
 * Native binding loader — lazy initialization.
 *
 * The binding is loaded on first access via `getNative()`, NOT at import time.
 * This allows pure-JS modules (schema, columns, table) to be imported without
 * requiring the native `.node` binary to be present.
 *
 * Uses `new URL("./file.node", import.meta.url)` — the standard bundler pattern.
 * Rspack/Webpack emits matching .node files as assets.
 */
import { dlopen } from "node:process";
import { fileURLToPath } from "node:url";

import { resolveTimeZone } from "../datetime.js";
import { toColumnarResult, toRowResult } from "../result.js";
import type { NativeResult, SybaseColumnarResult, SybaseFileResult } from "../result.js";

export interface NativeQueryOptions {
  maxRows?: number;
  /**
   * Hard timeout in ms. If the query has not produced a result by this
   * deadline, the returned promise rejects with `error.hardTimeout = true`
   * and the connection is marked dead so the pool replaces it.
   *
   * Note: the underlying libuv worker may continue running until db-lib's
   * cooperative DBSETTIME fires (set from the connection's `timeout`).
   * Its result is discarded.
   *
   * Defaults to `max(2 * connection.timeout * 1000, 30000)` on the native side.
   */
  hardTimeoutMs?: number;
  /**
   * Decode `datetime` and `smalldatetime` columns to `Date`, reading their
   * stored wall clock in this IANA zone. Without it they come back as canonical
   * `YYYY-MM-DD HH:MM:SS.mmm` text.
   */
  timeZone?: string;
}

export interface NativeBinding {
  connect(config: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    timeout?: number;
    /**
     * TDS network packet size in bytes. Defaults to 2048, ASE's out-of-the-box
     * `max network packet size`; more than the server allows fails the login.
     */
    packetSize?: number;
  }): Promise<unknown>;
  query(
    conn: unknown,
    sql: string,
    options?: NativeQueryOptions
  ): Promise<{
    rows: Record<string, unknown>[];
    columns: string[];
    /** Sybase system type name per column, in column order. */
    columnTypes: string[];
    rowCount: number;
    affectedRows: number;
  }>;
  /** Like {@link query}, but the result column by column. */
  queryColumns(
    conn: unknown,
    sql: string,
    options?: NativeQueryOptions
  ): Promise<SybaseColumnarResult>;
  /**
   * Like {@link query}, but the rows are written to a CSV file as they arrive
   * instead of being returned — see {@link SybaseFileResult} for the format.
   * Rows are not accumulated, so only an explicit `maxRows` caps them.
   * A failed query leaves no file behind.
   */
  queryToFile(
    conn: unknown,
    sql: string,
    options: NativeFileQueryOptions
  ): Promise<SybaseFileResult>;
  close(conn: unknown): void;
  isAlive(conn: unknown): boolean;
  /**
   * @internal The server's default character set (`iso_1`, `utf8`, ...), read
   * when the connection opened; `""` for a closed handle. Text is converted for
   * iso_1 and utf8, and passed through unconverted for any other.
   */
  serverCharset(conn: unknown): string;
  getVersion(): string;
}

/** Options of {@link NativeBinding.queryToFile}. */
export interface NativeFileQueryOptions extends Omit<NativeQueryOptions, "timeZone"> {
  /** File to write; replaced only once the query has succeeded. */
  path: string;
}

/** The addon's own exports. Its `query` resolves to the result column by column. */
interface NativeAddon extends Omit<NativeBinding, "query" | "queryColumns" | "queryToFile"> {
  query(
    conn: unknown,
    sql: string,
    options: {
      maxRows?: number;
      hardTimeoutMs?: number;
      wallClockDateTimes?: boolean;
      outputPath?: string;
    }
  ): Promise<NativeResult | SybaseFileResult>;
}

/**
 * The binding on top of the addon: decodes its column-by-column result.
 *
 * The addon is called synchronously, so an invalid handle still throws its
 * TypeError from the call itself rather than through the promise.
 */
const wrapAddon = (addon: NativeAddon): NativeBinding => {
  const run = (conn: unknown, sql: string, options: NativeQueryOptions | undefined) => {
    const timeZone =
      options?.timeZone === undefined ? undefined : resolveTimeZone(options.timeZone);
    const pending = (addon.query as (...args: unknown[]) => Promise<NativeResult>)(conn, sql, {
      maxRows: options?.maxRows,
      hardTimeoutMs: options?.hardTimeoutMs,
      wallClockDateTimes: timeZone !== undefined
    }).then(raw => {
      // An addon from an older build hands over rows instead.
      if (!Array.isArray(raw.data)) {
        throw new Error(
          "drizzle-sybase: the loaded native addon predates the JS layer (no column data in " +
            "its result). Reinstall drizzle-sybase so the bundled addon matches."
        );
      }
      return raw;
    });
    return { pending, timeZone };
  };
  return {
    connect: config => addon.connect(config),
    query: (conn, sql, options) => {
      const { pending, timeZone } = run(conn, sql, options);
      return pending.then(raw => toRowResult(raw, timeZone));
    },
    queryColumns: (conn, sql, options) => {
      const { pending, timeZone } = run(conn, sql, options);
      return pending.then(raw => toColumnarResult(raw, timeZone));
    },
    queryToFile: (conn, sql, options) => {
      // Checked here, before anything runs: a NUL would cut the path short in C.
      const path = (options as Partial<NativeFileQueryOptions> | undefined)?.path;
      if (typeof path !== "string" || path === "" || path.includes("\0")) {
        throw new TypeError("queryToFile: path must be a non-empty string without NUL characters");
      }
      return (
        addon.query(conn, sql, {
          maxRows: options.maxRows,
          hardTimeoutMs: options.hardTimeoutMs,
          outputPath: options.path
        }) as Promise<SybaseFileResult>
      ).then(result => {
        if (typeof (result as Partial<SybaseFileResult>).bytes !== "number") {
          throw new Error(
            "drizzle-sybase: the loaded native addon predates queryToFile. Reinstall drizzle-sybase " +
              "so the bundled addon matches."
          );
        }
        return result;
      });
    },
    close: conn => addon.close(conn),
    isAlive: conn => addon.isAlive(conn),
    serverCharset: conn => addon.serverCharset(conn),
    getVersion: () => addon.getVersion()
  };
};

function loadBundled(): NativeBinding | null {
  const platform = process.platform;
  const arch = process.arch;
  let addonUrl: URL;

  if (platform === "darwin" && arch === "arm64") {
    addonUrl = new URL("./sybase_native.darwin-arm64.node", import.meta.url);
  } else if (platform === "darwin" && arch === "x64") {
    addonUrl = new URL("./sybase_native.darwin-x64.node", import.meta.url);
  } else if (platform === "linux" && arch === "arm64") {
    addonUrl = new URL("./sybase_native.linux-arm64.node", import.meta.url);
  } else if (platform === "linux" && arch === "x64") {
    addonUrl = new URL("./sybase_native.linux-x64.node", import.meta.url);
  } else if (platform === "win32" && arch === "x64") {
    addonUrl = new URL("./sybase_native.win32-x64.node", import.meta.url);
  } else {
    return null;
  }

  try {
    const mod = { exports: {} } as { exports: NativeAddon };
    dlopen(mod, fileURLToPath(addonUrl));
    return wrapAddon(mod.exports);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `drizzle-sybase: failed to load native binding for ${platform}-${arch}.\n` +
        `Path: ${fileURLToPath(addonUrl)}\n` +
        `Reason: ${message}\n` +
        `This usually means the .node binary has an unresolved DLL dependency (e.g. sybdb.dll on Windows).`
    );
  }
}

let _binding: NativeBinding | null = null;
let _loaded = false;

/**
 * Get the native binding, loading it lazily on first call.
 * Throws if no binding is available for the current platform.
 */
export function getNative(): NativeBinding {
  if (!_loaded) {
    _binding = loadBundled(); // throws on dlopen failure; returns null on unsupported platform
    _loaded = true;
  }
  if (!_binding) {
    throw new Error(
      `drizzle-sybase: unsupported platform ${process.platform}-${process.arch}.\n` +
        `Supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64.`
    );
  }
  return _binding;
}

/**
 * Lazy-loaded native binding.
 * The binding is only loaded on first property access, allowing pure-JS modules
 * (schema, columns, table) to be imported without requiring the native binary.
 */
export const native: NativeBinding = new Proxy({} as NativeBinding, {
  get(_target, prop: string | symbol) {
    if (typeof prop === "symbol") {
      return undefined;
    }
    const binding = getNative();
    const value = (binding as any)[prop];
    // Bind functions so they work correctly when called detached
    if (typeof value === "function") {
      return value.bind(binding);
    }
    return value;
  }
});
