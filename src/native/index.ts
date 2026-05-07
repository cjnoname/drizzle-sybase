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

export interface NativeQueryOptions {
  maxRows?: number;
}

export interface NativeBinding {
  connect(config: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    timeout?: number;
  }): Promise<unknown>;
  query(
    conn: unknown,
    sql: string,
    options?: NativeQueryOptions
  ): Promise<{
    rows: Record<string, unknown>[];
    columns: string[];
    rowCount: number;
    affectedRows: number;
  }>;
  close(conn: unknown): void;
  isAlive(conn: unknown): boolean;
  getVersion(): string;
}

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
    const mod = { exports: {} } as { exports: NativeBinding };
    dlopen(mod, fileURLToPath(addonUrl));
    return mod.exports;
  } catch {
    return null;
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
    _binding = loadBundled();
    _loaded = true;
  }
  if (!_binding) {
    throw new Error(
      `drizzle-sybase: no native binding for ${process.platform}-${process.arch}.\n` +
      `Ensure the package was installed correctly (all platform .node files should be in dist/native/).`
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
