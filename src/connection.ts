import { copyRows, validateBulkInsertOptions } from "./bulk.js";
import type { BulkIo, SybaseBulkInsertOptions, SybaseBulkInsertResult } from "./bulk.js";
import { checkInteger, MAX_INT32 } from "./checks.js";
/**
 * A single Sybase connection over the native db-lib addon: opening it (and
 * establishing the session baseline), serialized queries, timeouts, and
 * restoring the session state. Also the options and validation it shares with
 * the pool (see `./pool.ts`).
 */
import { describeTimeZoneMismatch, resolveTimeZone } from "./datetime.js";
import { escapeName } from "./dialect.js";
import {
  messageOf,
  SybaseBulkCopyError,
  SybaseError,
  SybaseConnectionError,
  SybaseQueryError,
  SybaseTimeoutError
} from "./errors.js";
import { native } from "./native/index.js";
import type { NativeQueryOptions } from "./native/index.js";
import type { SybaseColumnarResult, SybaseFileResult } from "./result.js";

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
  /**
   * With {@link SybaseQueryOptions.allResultSets} only: the rows of every
   * result set that has columns, in order — the first is `rows`.
   */
  resultSets?: Record<string, unknown>[][];
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
  /**
   * Cooperative timeout for this call alone, in seconds, in place of the
   * connection's `timeout`. When it passes, db-lib cancels the statement and
   * the call fails with a `SybaseTimeoutError`; the connection stays usable.
   *
   * It limits each wait for the server, not the whole call: a query whose
   * rows keep arriving is not interrupted by it however long it runs. The
   * whole call is bounded by the hard timeout instead.
   *
   * It is set on this call's connection only (db-lib's `DBSETTIME` option of
   * that DBPROCESS, not the process-wide `dbsettime()`), for the duration of
   * the call, and restored afterwards — a connection runs one call at a time,
   * so no other call, on this connection or another, ever sees it. The default
   * hard timeout follows it: `max(2 * timeoutSeconds * 1000, 30000)` ms.
   */
  timeoutSeconds?: number;
  /**
   * Hard timeout in ms (see {@link SybaseConnectionConfig.hardTimeoutMs}): the
   * longest the call can take. `timeoutSeconds` limits each wait for the
   * server, not the call — a query whose rows keep arriving runs past it — so
   * budget on this instead: the call settles by `hardTimeoutMs` (plus at most
   * a second), whatever the query does.
   */
  hardTimeoutMs?: number;
  /**
   * Return every result set that has columns — e.g. of a procedure that
   * selects several times — as `resultSets`, not only the first. `rows` (or
   * `columns`) still describes the first, so the default shape is unchanged;
   * `maxRows` caps each set on its own. Not available with `executeToFile`,
   * which writes one result set.
   */
  allResultSets?: boolean;
  /**
   * @internal Decode `datetime` / `smalldatetime` columns to `Date`, reading
   * their wall clock in this zone. Sessions set it from their configured zone;
   * without it those columns come back as canonical text.
   */
  timeZone?: string;
}

/** Options for a query whose rows are written to a file (see {@link SybaseFileResult}). */
export interface SybaseFileQueryOptions extends Omit<
  SybaseQueryOptions,
  "timeZone" | "allResultSets"
> {
  /** File to write; replaced only once the query has succeeded. */
  path: string;
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

export { checkInteger, MAX_INT32 };

/**
 * Default TDS packet size: ASE's out-of-the-box `max network packet size`, so
 * a server with stock settings accepts the login.
 */
const DEFAULT_PACKET_SIZE = 2048;

/** The lowest `max network packet size` a server can be configured with. */
const MIN_SERVER_PACKET_SIZE = 512;

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
  // Seconds; the hard timeout derived from it (2x, in ms) must fit an int.
  checkInteger("timeoutSeconds", options?.timeoutSeconds, 1, Math.floor(MAX_INT32 / 2000));
  checkInteger("hardTimeoutMs", options?.hardTimeoutMs, 1, MAX_INT32);
  if (options?.allResultSets !== undefined && typeof options.allResultSets !== "boolean") {
    throw new TypeError("allResultSets must be a boolean");
  }
};

/** Validate the options of a query written to a file. */
/** @internal */
export const validateFileQueryOptions = (options: SybaseFileQueryOptions | undefined): void => {
  validateQueryOptions(options);
  if ((options as SybaseQueryOptions | undefined)?.allResultSets) {
    throw new TypeError(
      "allResultSets is not available when writing to a file: a file holds one result set"
    );
  }
  const path = (options as Partial<SybaseFileQueryOptions> | undefined)?.path;
  if (typeof path !== "string" || path === "" || path.includes("\0")) {
    throw new TypeError("path must be a non-empty string without NUL characters");
  }
};

/**
 * How long after its hard timeout a call is abandoned on the JS side if the
 * native side has not answered: every call settles by `hardTimeoutMs` plus
 * this.
 */
const JS_HARD_TIMEOUT_GRACE_MS = 1000;

/** Character sets whose text is converted; any other is passed through (see `serverCharset`). */
const CONVERTED_CHARSETS: ReadonlySet<string> = new Set(["iso_1", "utf8"]);

/** Servers already warned about an unconverted character set. */
const charsetWarned = new Set<string>();

/**
 * Warn — once per server — when its character set is one the driver does not
 * convert: non-ASCII text then passes through as the server's raw bytes, which
 * reads as U+FFFD and writes as the wrong characters.
 */
const warnOnUnconvertedCharset = (config: SybaseConnectionConfig, charset: string): void => {
  const key = `${config.host}:${config.port}`;
  if (CONVERTED_CHARSETS.has(charset) || charsetWarned.has(key)) {
    return;
  }
  charsetWarned.add(key);
  process.emitWarning(
    `${key}: the server's character set is ${charset}, which drizzle-sybase does not convert ` +
      "(only iso_1 and utf8): non-ASCII char/varchar/text values pass through as raw bytes.",
    { code: "DRIZZLE_SYBASE_CHARSET" }
  );
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
  /**
   * Bumped whenever the handle is given up (closed or replaced). A call belongs
   * to the generation it was queued in: it does not run on a connection opened
   * since — whose session is not the one it was meant for — and its failure
   * or timeout closes its own handle, never a newer one.
   */
  private generation = 0;
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
      this.generation++;
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
      let message = messageOf(err);
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
      throw new SybaseConnectionError(`Could not initialise the session: ${messageOf(err)}`, {
        host: this.config.host,
        port: this.config.port
      });
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
    warnOnUnconvertedCharset(this.config, native.serverCharset(handle));
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

  /**
   * Like {@link query}, but the rows are written to a CSV file as they arrive
   * — one row held at a time, never turned into JS values. See
   * {@link SybaseFileResult} for the format. A failed query leaves no file.
   */
  async queryToFile(sql: string, options: SybaseFileQueryOptions): Promise<SybaseFileResult> {
    validateFileQueryOptions(options);
    return this.enqueue(sql, options, (handle, nativeOptions) =>
      native.queryToFile(handle, sql, {
        maxRows: nativeOptions.maxRows,
        timeoutSeconds: nativeOptions.timeoutSeconds,
        hardTimeoutMs: nativeOptions.hardTimeoutMs,
        path: options.path
      })
    );
  }

  /**
   * Bulk copy rows into a table — db-lib's bcp, in process. See
   * {@link SybaseBulkInsertOptions} for the options and the README's "Bulk
   * Copy" section for atomicity and locking.
   *
   * Runs outside any transaction (it is refused inside one). If the copy fails
   * after it has started, the connection is closed — that is what makes the
   * server roll back the open batch — and the `SybaseBulkCopyError` says what
   * earlier batches committed. `connect()` opens a new one.
   */
  async bulkInsert(options: SybaseBulkInsertOptions): Promise<SybaseBulkInsertResult> {
    validateBulkInsertOptions(options);
    // One task on the queue for the whole copy: nothing else may run on the
    // DBPROCESS while it is in the middle of one.
    const generation = this.generation;
    const task = this.queryQueue.then(() => this.executeBulkInsert(generation, options));
    this.queryQueue = task.catch(() => {});
    return task;
  }

  private async executeBulkInsert(
    generation: number,
    options: SybaseBulkInsertOptions
  ): Promise<SybaseBulkInsertResult> {
    const handle = this.handle;
    if (!handle || this.closed || generation !== this.generation) {
      throw new SybaseConnectionError("Connection is closed", {
        host: this.config.host,
        port: this.config.port
      });
    }
    const { timeoutS, hardMs } = this.timeoutsFor(options);
    // On the monotonic clock: a wall-clock step must not stretch or cut it.
    const deadline = performance.now() + hardMs;
    const deadlineError = () =>
      new SybaseTimeoutError(
        `Bulk copy exceeded its hard timeout of ${hardMs}ms; the connection was closed, which ` +
          "rolls back the open batch",
        "query",
        hardMs,
        true
      );

    // Before the deadline's timer: nothing may throw between it and the try
    // that clears it.
    const timeZone = resolveTimeZone(this.config.timeZone);
    let expired = false;
    let rejectExpiry!: (err: Error) => void;
    // The deadline covers the whole call — reading the caller's rows too, when
    // no native watchdog runs — so it is kept here. Closing the connection is
    // what abandons the copy: the server rolls back the batch it never saw end,
    // and the native side refuses to commit on a closed connection.
    const expiry = new Promise<never>((_, reject) => {
      rejectExpiry = reject;
    });
    expiry.catch(() => {});
    const expire = () => {
      if (!expired) {
        expired = true;
        clearTimeout(timer);
        this.closeHandle(handle);
        rejectExpiry(deadlineError());
      }
    };
    // Kept referenced: while the copy waits for the caller's rows, no native
    // work may be under way, and this timer is then all that settles the call
    // (a process with nothing else to do would otherwise exit mid-copy).
    const timer = setTimeout(expire, hardMs);

    const remainingMs = () => Math.max(1, Math.ceil(deadline - performance.now()));
    const io: BulkIo = {
      begin: begin => native.bulkBegin(handle, { ...begin, hardTimeoutMs: remainingMs() }),
      send: chunk => native.bulkSend(handle, { ...chunk, hardTimeoutMs: remainingMs() }),
      race: promise => {
        // Settled late after a timeout: nothing waits for it any more.
        promise.catch(() => {});
        return Promise.race([promise, expiry]);
      },
      get expired() {
        return expired;
      },
      checkDeadline: () => {
        if (!expired && performance.now() >= deadline) {
          expire();
        }
        return expired;
      },
      deadlineError,
      abandon: () => this.closeHandle(handle),
      toCause: err => this.bulkCause(err, options.table, timeoutS, hardMs),
      timeZone
    };
    try {
      return await copyRows(io, options);
    } catch (err) {
      // Kept only when the copy says it left the connection as it was (it
      // failed before anything was sent): a connection in the middle of a copy
      // takes no other command, and its open batch must be rolled back.
      if (!(err instanceof SybaseBulkCopyError) || err.connectionDead) {
        this.closeHandle(handle);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The timeouts a call runs under: its cooperative timeout in seconds, and its
   * hard timeout — the one given (for the call, or configured), else derived
   * as `max(2 * timeout, 30 s)`, the same default the native side computes
   * when given none. A call with its own `timeoutSeconds` derives its own hard
   * timeout rather than inheriting a configured one.
   */
  private timeoutsFor(options: { timeoutSeconds?: number; hardTimeoutMs?: number } | undefined): {
    timeoutS: number;
    explicitHardMs: number | undefined;
    hardMs: number;
  } {
    const timeoutS = options?.timeoutSeconds ?? this.config.timeout ?? 30;
    const explicitHardMs =
      options?.hardTimeoutMs ??
      (options?.timeoutSeconds === undefined ? this.config.hardTimeoutMs : undefined);
    return { timeoutS, explicitHardMs, hardMs: explicitHardMs ?? Math.max(timeoutS * 2000, 30000) };
  }

  /** The error class a failure of the native bulk copy stands for. */
  private bulkCause(err: any, table: string, timeoutS: number, hardMs: number): Error {
    // Every failure of bulkBegin / bulkSend says whether the connection is
    // reusable; anything else is already ours (a passed deadline, a JS error).
    if (err instanceof Error && !("reusable" in err)) {
      return err;
    }
    const message = messageOf(err);
    if (err?.hardTimeout) {
      return new SybaseTimeoutError(message, "query", hardMs, true);
    }
    // A value the native side could not convert (past maxErrors): as one the
    // JS side refuses.
    if (err?.valueRefused) {
      return new TypeError(message);
    }
    if (err?.timedOut) {
      return new SybaseTimeoutError(message, "query", timeoutS * 1000, err?.reusable !== true);
    }
    if (err?.connectionLost) {
      return new SybaseConnectionError(message, { host: this.config.host, port: this.config.port });
    }
    return new SybaseQueryError(message, {
      sql: `insert bulk ${table}`,
      connectionDead: err?.reusable !== true
    });
  }

  private enqueue<R>(
    sql: string,
    options: SybaseQueryOptions | undefined,
    run: (handle: unknown, nativeOptions: NativeQueryOptions) => Promise<R>
  ): Promise<R> {
    validateQueryOptions(options);
    // Serialize queries on this connection — db-lib DBPROCESS is not reentrant.
    const generation = this.generation;
    const task = this.queryQueue.then(() => this.executeQuery(generation, sql, options, run));
    // Update queue head; swallow rejections so subsequent queries still run.
    this.queryQueue = task.catch(() => {});
    return task;
  }

  private async executeQuery<R>(
    generation: number,
    sql: string,
    options: SybaseQueryOptions | undefined,
    run: (handle: unknown, nativeOptions: NativeQueryOptions) => Promise<R>
  ): Promise<R> {
    const handle = this.handle;
    if (!handle || this.closed || generation !== this.generation) {
      throw new SybaseConnectionError("Connection is closed", {
        host: this.config.host,
        port: this.config.port
      });
    }

    const {
      timeoutS: baseTimeoutS,
      explicitHardMs: nativeHardMs,
      hardMs: effectiveHardMs
    } = this.timeoutsFor(options);
    // JS-side fallback, just after the native watchdog. The watchdog stops a
    // worker that is reading rows within moments; this covers one blocked in a
    // single wait on the server (which only DBSETTIME ends) or one that never
    // started (queued behind a full libuv pool). Either way the call settles
    // by hardTimeoutMs + JS_HARD_TIMEOUT_GRACE_MS — the bound a caller can
    // budget on — and the connection is closed so the pool replaces it.
    // Capped: setTimeout treats a delay past 2^31-1 ms as 1 ms.
    const jsHardMs = Math.min(effectiveHardMs + JS_HARD_TIMEOUT_GRACE_MS, MAX_INT32);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Close now rather than leave it to the pool: the native side then
        // knows the caller has given up, and does not publish an export that
        // finishes after this rejection (see queryToFile). The close is
        // deferred natively until the stuck worker returns.
        this.closeHandle(handle);
        reject(
          new SybaseTimeoutError(
            `Query exceeded hard timeout of ${effectiveHardMs} ms — the connection was abandoned`,
            "query",
            effectiveHardMs,
            true
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
    if (options?.timeoutSeconds !== undefined) {
      nativeOptions.timeoutSeconds = options.timeoutSeconds;
    }
    if (nativeHardMs !== undefined) {
      nativeOptions.hardTimeoutMs = nativeHardMs;
    }
    if (options?.timeZone !== undefined) {
      nativeOptions.timeZone = options.timeZone;
    }
    if (options?.allResultSets) {
      nativeOptions.allResultSets = true;
    }

    try {
      return await Promise.race([run(handle, nativeOptions), timeoutPromise]);
    } catch (err: any) {
      // Already the driver's own (the JS hard-timeout fallback above): as it is.
      if (err instanceof SybaseTimeoutError || err instanceof SybaseConnectionError) {
        throw err;
      }
      // A connection the call left unusable (its hard timeout fired, or it
      // died) is closed now, not only marked: closing frees the native side
      // and the server session, also for a caller that never calls close().
      if (err && (err.hardTimeout || err.connectionDead)) {
        this.closeHandle(handle);
      }
      // Native-side hard timeout — connection is dead.
      if (err && err.hardTimeout) {
        throw new SybaseTimeoutError(
          messageOf(err, "Query hard timeout"),
          "query",
          effectiveHardMs,
          true
        );
      }
      // Cooperative timeout (db-lib's DBSETTIME fired). Connection itself
      // may still be usable, but to be safe we let the pool decide via
      // isConnected().
      if (err && err.timedOut) {
        throw new SybaseTimeoutError(
          messageOf(err, "Query timed out"),
          "query",
          baseTimeoutS * 1000,
          err.connectionDead === true
        );
      }
      // Dead connection (e.g. server dropped, network gone)
      if (err && err.connectionDead) {
        throw new SybaseConnectionError(messageOf(err), {
          host: this.config.host,
          port: this.config.port
        });
      }
      throw new SybaseQueryError(messageOf(err), {
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
    this.generation++;
  }

  /**
   * Close this connection if `handle` is still its handle. Otherwise it was
   * closed already — a handle is only ever given up by closing it (close(),
   * open()) — and a call on it must not close the connection opened since.
   */
  private closeHandle(handle: unknown): void {
    if (handle === this.handle) {
      this.close();
    }
  }

  get isConnected(): boolean {
    if (!this.handle || this.closed) {
      return false;
    }
    return native.isAlive(this.handle);
  }
}
