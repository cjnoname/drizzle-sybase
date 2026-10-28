/**
 * A single Sybase connection over the native db-lib addon: opening it (and
 * establishing the session baseline), serialized queries, timeouts, and
 * restoring the session state. Also the options and validation it shares with
 * the pool (see `./pool.ts`).
 */
import { describeTimeZoneMismatch, resolveTimeZone } from "./datetime.js";
import { escapeName } from "./dialect.js";
import {
  SybaseError,
  SybaseConnectionError,
  SybaseQueryError,
  SybaseTimeoutError
} from "./errors.js";
import { native } from "./native/index.js";
import type { NativeQueryOptions } from "./native/index.js";
import type { SybaseColumnarResult } from "./result.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SybaseConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  /** Connection/query timeout in seconds. Default: 30 */
  timeout?: number;
  /**
   * TDS network packet size in bytes. Larger values reduce round-trips for big
   * result sets. Default: 2048 — ASE's out-of-the-box `max network packet
   * size`. A server refuses the login (with the same "Login failed" as a wrong
   * password) when this exceeds its `max network packet size`, which a DBA can
   * set as low as 512; set it to fit such a server.
   */
  packetSize?: number;
  /**
   * Hard timeout for individual queries in ms. Acts as a last-resort
   * watchdog if db-lib's cooperative timeout fails to abort a stuck I/O
   * (e.g. server unresponsive after CANCEL). When this fires, the query
   * rejects with a timeout error and the connection is marked dead so the
   * pool replaces it.
   *
   * Defaults to `max(2 * timeout * 1000, 30000)` on the native side.
   */
  hardTimeoutMs?: number;
  /**
   * IANA zone the ASE server keeps its clocks in, e.g. `Australia/Sydney`.
   * Default: `UTC`.
   *
   * `datetime` / `smalldatetime` columns store a naive wall clock with no
   * offset, so this is the only way the driver can map them to instants. It is
   * used in both directions: `Date` values are written as this zone's wall clock
   * and datetime columns are read back as the `Date` that wall clock denotes
   * here. Leaving it unset makes reads and writes exact inverses in UTC, which
   * is correct as long as nothing else interprets the stored values.
   *
   * Validated when the connection is created, not on first use.
   */
  timeZone?: string;
  /**
   * @internal `false` skips the warning about a server clock outside
   * {@link timeZone}, for connections that read no datetime values (schema
   * introspection), where it would only be noise.
   */
  warnOnTimeZoneMismatch?: boolean;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  columns: string[];
  /**
   * Sybase system type name per column, in column order (`datetime`, `money`,
   * `varchar`, ...). Reported by the native addon so results can be decoded by
   * type even for raw SQL with no schema attached.
   */
  columnTypes: string[];
  rowCount: number;
  affectedRows: number;
}

// ---------------------------------------------------------------------------
// Logger / Middleware
// ---------------------------------------------------------------------------

/**
 * Query log entry passed to the logger callback.
 */
export interface SybaseQueryLog {
  /** The SQL string that was executed. */
  sql: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Number of rows returned/affected. */
  rowCount: number;
  /** Whether the query resulted in an error. */
  error?: Error;
  /** Timestamp when the query started. */
  timestamp: Date;
}

/**
 * Logger interface for query observability.
 *
 * @example
 * ```ts
 * const logger: SybaseLogger = {
 *   query(log) {
 *     console.log(`[${log.durationMs}ms] ${log.sql}`);
 *   }
 * };
 * ```
 */
export interface SybaseLogger {
  /** Called after every query execution (success or failure). */
  query(log: SybaseQueryLog): void;
}

/**
 * Hand a log entry to the logger, isolating the caller from it: a throwing
 * logger must not turn a successful query into a failure, nor skip releasing
 * or rolling back the connection.
 *
 * @internal
 */
export const emitQueryLog = (logger: SybaseLogger | undefined, log: SybaseQueryLog): void => {
  if (!logger) {
    return;
  }
  try {
    logger.query(log);
  } catch {
    // Observability must not affect query outcome.
  }
};

/** Options for a single query. */
export interface SybaseQueryOptions {
  /** Cap on the rows returned; rows past it are discarded. */
  maxRows?: number;
  /** Hard timeout in ms (see {@link SybaseConnectionConfig.hardTimeoutMs}). */
  hardTimeoutMs?: number;
  /**
   * @internal Decode `datetime` / `smalldatetime` columns to `Date`, reading
   * their wall clock in this zone. Sessions set it from their configured zone;
   * without it those columns come back as canonical text.
   */
  timeZone?: string;
}

/**
 * A single integer server variable from a one-row result, or `undefined` if
 * the result is not shaped that way. `Number(null)` and `Number("")` are 0, so
 * those are rejected explicitly — a missing value must not read as one.
 *
 * @internal
 */
export const readServerInt = (rows: unknown[], key: string): number | undefined => {
  const row = rows.length === 1 ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const raw = row?.[key];
  if (typeof raw !== "number" && !(typeof raw === "string" && /^-?\d+$/.test(raw))) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

// ---------------------------------------------------------------------------
// Single connection
// ---------------------------------------------------------------------------

/** @internal */
export const MAX_INT32 = 2_147_483_647;

/**
 * Default TDS packet size: ASE's out-of-the-box `max network packet size`, so
 * a server with stock settings accepts the login.
 */
const DEFAULT_PACKET_SIZE = 2048;

/** The lowest `max network packet size` a server can be configured with. */
const MIN_SERVER_PACKET_SIZE = 512;

/**
 * Reject a numeric option that is not an integer in range. These values end
 * up in timers (which treat anything past 2^31-1 ms as 1 ms), in C ints, or in
 * pool arithmetic where `NaN` makes every comparison false and the pool never
 * opens a connection — each a silent malfunction, so a bad value fails here.
 */
/** @internal */
export const checkInteger = (
  name: string,
  value: number | undefined,
  min: number,
  max: number,
  message = `${name} must be an integer between ${min} and ${max}`
): void => {
  if (value !== undefined && !(Number.isInteger(value) && value >= min && value <= max)) {
    throw new RangeError(`${message}, got ${String(value)}`);
  }
};

/** Validate the options a single connection uses. */
/** @internal */
export const validateConnectionConfig = (config: SybaseConnectionConfig): void => {
  checkInteger("port", config.port, 1, 65_535);
  // Seconds; the native hard timeout derived from it (2x, in ms) must fit an int.
  checkInteger("timeout", config.timeout, 0, Math.floor(MAX_INT32 / 2000));
  checkInteger("packetSize", config.packetSize, 512, 65_535);
  checkInteger("hardTimeoutMs", config.hardTimeoutMs, 1, MAX_INT32);
  // `timeZone` is consumed by the session and dialect, not here, but this is a
  // public entry point that accepts it — validating it here keeps the promise
  // on `SybaseConnectionConfig.timeZone` true wherever a config is accepted.
  resolveTimeZone(config.timeZone);
};

/** Validate the options of a single query. */
/** @internal */
export const validateQueryOptions = (options: SybaseQueryOptions | undefined): void => {
  checkInteger("maxRows", options?.maxRows, 1, MAX_INT32);
  checkInteger("hardTimeoutMs", options?.hardTimeoutMs, 1, MAX_INT32);
};

/** Servers already warned about, so a pool does not warn once per connection. */
const timeZoneWarned = new Set<string>();

/**
 * Warn — once per server, database and zone — when the server's clock is not
 * in the zone datetime values are converted in. Every datetime read or written
 * would be off by the difference, so it must not pass unnoticed; but it is a
 * warning, not an error, because an application may compensate for it itself
 * and must be able to start while that is sorted out.
 */
const warnOnTimeZoneMismatch = (config: SybaseConnectionConfig, serverOffset: number): void => {
  const timeZone = resolveTimeZone(config.timeZone);
  const key = `${config.host}:${config.port}/${config.database}/${timeZone}`;
  if (timeZoneWarned.has(key)) {
    return;
  }
  const mismatch = describeTimeZoneMismatch(serverOffset, timeZone);
  if (mismatch) {
    timeZoneWarned.add(key);
    process.emitWarning(`${key}: ${mismatch}`, { code: "DRIZZLE_SYBASE_TIMEZONE" });
  }
};

/**
 * A single Sybase connection wrapping the native FreeTDS handle.
 *
 * Normally you won't use this directly — use `SybasePool` instead.
 * This class manages the lifecycle of a single db-lib connection.
 */
export class SybaseConnection {
  private handle: unknown = null;
  private closed = false;
  /** Promise queue to serialize queries on a single DBPROCESS (not thread-safe). */
  private queryQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: SybaseConnectionConfig) {
    validateConnectionConfig(config);
  }

  async connect(): Promise<void> {
    if (this.handle && !this.closed) {
      return;
    }
    // Concurrent callers share one attempt; a second native connect would
    // overwrite `handle` and leak the first.
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private connecting: Promise<void> | null = null;

  private async open(): Promise<void> {
    // A handle abandoned after a hard timeout is still open natively.
    if (this.handle) {
      try {
        native.close(this.handle);
      } catch {
        // Ignore close errors
      }
      this.handle = null;
    }
    this.closed = false;
    const packetSize = this.config.packetSize ?? DEFAULT_PACKET_SIZE;
    let handle: unknown;
    try {
      handle = await native.connect({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        username: this.config.username,
        password: this.config.password,
        timeout: this.config.timeout ?? 30,
        packetSize
      });
    } catch (err: any) {
      let message: string = err.message ?? String(err);
      // ASE refuses an oversized packet with the same message as bad
      // credentials; say so, or the user will only check the password.
      if (/Msg 4002\b/.test(message) && packetSize > MIN_SERVER_PACKET_SIZE) {
        message +=
          ` (packetSize is ${packetSize}: if the credentials are right, the server's ` +
          `'max network packet size' may be lower — set packetSize to fit it)`;
      }
      throw new SybaseConnectionError(message, {
        host: this.config.host,
        port: this.config.port
      });
    }
    // close() was called while connecting — honour it rather than resurrect
    // the connection with a handle nothing would ever close.
    if (this.closed) {
      native.close(handle);
      throw new SybaseConnectionError("Connection was closed while connecting", {
        host: this.config.host,
        port: this.config.port
      });
    }
    // Establish the baseline every pooled user can rely on. A login trigger
    // can switch on chained mode, where every statement opens a transaction
    // that nothing would ever commit; the isolation level found here is what
    // {@link resetSessionState} restores.
    let isolation: number | undefined;
    let serverOffset: number | undefined;
    try {
      const { rows } = (await native.query(
        handle,
        "if @@tranchained = 1 set chained off\n" +
          // In seconds: the two clocks are read an instant apart, and datediff
          // counts boundaries crossed, so a minute count can be off by one.
          "select @@isolation as iso, datediff(second, getutcdate(), getdate()) as tz",
        {}
      )) as unknown as QueryResult;
      isolation = readServerInt(rows, "iso");
      const offsetSeconds = readServerInt(rows, "tz");
      serverOffset = offsetSeconds === undefined ? undefined : Math.round(offsetSeconds / 60);
    } catch (err: any) {
      native.close(handle);
      throw new SybaseConnectionError(
        `Could not initialise the session: ${err?.message ?? String(err)}`,
        { host: this.config.host, port: this.config.port }
      );
    }
    if (isolation === undefined || isolation < 0 || isolation > 3) {
      native.close(handle);
      throw new SybaseConnectionError("Could not read the session isolation level", {
        host: this.config.host,
        port: this.config.port
      });
    }
    // close() may have been called while the session was being initialised:
    // `this.handle` was not set yet, so it could not close this one.
    if (this.closed) {
      native.close(handle);
      throw new SybaseConnectionError("Connection was closed while connecting", {
        host: this.config.host,
        port: this.config.port
      });
    }
    this.baseline = isolation;
    this.handle = handle;
    if (serverOffset !== undefined && this.config.warnOnTimeZoneMismatch !== false) {
      warnOnTimeZoneMismatch(this.config, serverOffset);
    }
  }

  /** Isolation level the session had when it was opened; what {@link resetSessionState} restores. */
  private baseline = 1;

  /**
   * Return the session to the state it was opened in: no open transaction,
   * unchained, `ROWCOUNT 0`, the original isolation level and the configured
   * database — so whatever a statement changed cannot reach the next user of a
   * pooled connection.
   *
   * Resolves to whether a transaction was left open or chained mode was on
   * (both are undone). Rejects if the state cannot be established; the caller
   * must then discard the connection.
   *
   * @internal
   */
  async resetSessionState(): Promise<{ leftOpen: boolean }> {
    const { rows } = await this.query<Record<string, unknown>>(
      [
        "SET ROWCOUNT 0",
        "select @@trancount as tc, @@tranchained as ch",
        "if @@trancount > 0 rollback tran",
        "if @@tranchained = 1 set chained off",
        `SET TRANSACTION ISOLATION LEVEL ${this.baseline}`,
        // After the rollback: `use` is not allowed inside a transaction.
        `use ${escapeName(this.config.database)}`
      ].join("\n")
    );
    const trancount = readServerInt(rows, "tc");
    const chained = readServerInt(rows, "ch");
    if (trancount === undefined || chained === undefined) {
      throw new SybaseError("Could not read the session state");
    }
    return { leftOpen: trancount > 0 || chained !== 0 };
  }

  /**
   * Drop every temporary table this session has created, so a pooled
   * connection does not hand them to its next user.
   *
   * ASE stores `#t` in the session's tempdb (one of several, see
   * `@@tempdbid`) as `#t` plus a 17-character session suffix. A row is this
   * session's own exactly when `object_id` of its base name — resolved per
   * session — is that row's id. Temporary table names cannot be quoted
   * (Msg 11717), so the base names are used as they are.
   *
   * @internal
   */
  async dropTempTables(): Promise<void> {
    const { rows } = await this.query<{ name: string }>(
      "declare @db varchar(30) select @db = db_name(@@tempdbid) " +
        "exec('select substring(name, 1, char_length(name) - 17) as name from ' + @db + " +
        "'..sysobjects where type = ''U'' and name like ''#%'' " +
        "and object_id(substring(name, 1, char_length(name) - 17)) = id')"
    );
    if (rows.length > 0) {
      await this.query(rows.map(row => `drop table ${row.name}`).join("\n"));
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    options?: SybaseQueryOptions
  ): Promise<QueryResult<T>> {
    return this.enqueue(sql, options, (handle, nativeOptions) =>
      native.query(handle, sql, nativeOptions)
    ) as Promise<QueryResult<T>>;
  }

  /**
   * Like {@link query}, but the result column by column — for bulk reads, where
   * building an object per row is most of the cost.
   */
  async queryColumns(sql: string, options?: SybaseQueryOptions): Promise<SybaseColumnarResult> {
    return this.enqueue(sql, options, (handle, nativeOptions) =>
      native.queryColumns(handle, sql, nativeOptions)
    );
  }

  private enqueue<R>(
    sql: string,
    options: SybaseQueryOptions | undefined,
    run: (handle: unknown, nativeOptions: NativeQueryOptions) => Promise<R>
  ): Promise<R> {
    validateQueryOptions(options);
    // Serialize queries on this connection — db-lib DBPROCESS is not reentrant.
    const task = this.queryQueue.then(() => this.executeQuery(sql, options, run));
    // Update queue head; swallow rejections so subsequent queries still run.
    this.queryQueue = task.catch(() => {});
    return task;
  }

  private async executeQuery<R>(
    sql: string,
    options: SybaseQueryOptions | undefined,
    run: (handle: unknown, nativeOptions: NativeQueryOptions) => Promise<R>
  ): Promise<R> {
    if (!this.handle || this.closed) {
      throw new SybaseConnectionError("Connection is closed", {
        host: this.config.host,
        port: this.config.port
      });
    }

    const baseTimeoutS = this.config.timeout ?? 30;
    const nativeHardMs = options?.hardTimeoutMs ?? this.config.hardTimeoutMs;
    // Mirrors the native default (see binding.c) so errors report the real value.
    const effectiveHardMs = nativeHardMs ?? Math.max(baseTimeoutS * 2 * 1000, 30000);
    // JS-side fallback: even longer than the native watchdog. If THIS fires,
    // the native worker is stuck despite dbcancel — we bail at the JS layer
    // and mark the connection dead so the pool replaces it. The worker may
    // continue running until the OS finally gives up the socket; that's
    // acceptable because libuv's worker pool will reclaim the slot eventually.
    const jsHardMs = effectiveHardMs + 5000;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Mark dead so the pool will discard this connection on release.
        this.closed = true;
        reject(
          new SybaseTimeoutError(
            `Query exceeded JS-side hard timeout of ${jsHardMs}ms; ` +
              `native worker did not respond to cancel and connection has been abandoned`,
            "query",
            jsHardMs
          )
        );
      }, jsHardMs);
      // Don't keep the event loop alive just for this timer.
      if (timer && typeof (timer as any).unref === "function") {
        (timer as any).unref();
      }
    });

    const nativeOptions: NativeQueryOptions = {};
    if (options?.maxRows !== undefined) {
      nativeOptions.maxRows = options.maxRows;
    }
    if (nativeHardMs !== undefined) {
      nativeOptions.hardTimeoutMs = nativeHardMs;
    }
    if (options?.timeZone !== undefined) {
      nativeOptions.timeZone = options.timeZone;
    }

    try {
      return await Promise.race([run(this.handle, nativeOptions), timeoutPromise]);
    } catch (err: any) {
      // Native-side hard timeout — connection is dead.
      if (err && err.hardTimeout) {
        this.closed = true;
        throw new SybaseTimeoutError(err.message ?? "Query hard timeout", "query", effectiveHardMs);
      }
      // Cooperative timeout (db-lib's DBSETTIME fired). Connection itself
      // may still be usable, but to be safe we let the pool decide via
      // isConnected().
      if (err && err.timedOut) {
        throw new SybaseTimeoutError(
          err.message ?? "Query timed out",
          "query",
          baseTimeoutS * 1000
        );
      }
      // Dead connection (e.g. server dropped, network gone)
      if (err && err.connectionDead) {
        this.closed = true;
        throw new SybaseConnectionError(err.message ?? String(err), {
          host: this.config.host,
          port: this.config.port
        });
      }
      if (err instanceof SybaseTimeoutError || err instanceof SybaseConnectionError) {
        throw err;
      }
      throw new SybaseQueryError(err.message ?? String(err), {
        sql,
        connectionDead: false
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  close(): void {
    if (this.handle) {
      try {
        native.close(this.handle);
      } catch {
        // Ignore close errors
      }
      this.handle = null;
    }
    this.closed = true;
  }

  get isConnected(): boolean {
    if (!this.handle || this.closed) {
      return false;
    }
    return native.isAlive(this.handle);
  }
}
