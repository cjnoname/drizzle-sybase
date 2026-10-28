/**
 * Sybase session — wraps connection pool to provide query execution.
 *
 * Transactions hold a single connection for the entire duration,
 * with proper BEGIN/COMMIT/ROLLBACK semantics.
 * Supports transaction isolation levels.
 */
import type {
  SybaseConnection,
  QueryResult,
  SybaseLogger,
  SybaseQueryOptions
} from "./connection.js";
import { emitQueryLog, readServerInt } from "./connection.js";
import { resolveTimeZone } from "./datetime.js";
import { SybaseConnectionError, SybaseError } from "./errors.js";
import type { SybasePool } from "./pool.js";
import type { SybaseColumnarResult } from "./result.js";
import {
  endsTransaction,
  mayChangeIdentity,
  mayCreateTempTable,
  mayLeaveSessionState
} from "./sql-classify.js";

// ---------------------------------------------------------------------------
// Transaction isolation levels
// ---------------------------------------------------------------------------

/**
 * Sybase ASE transaction isolation levels.
 *
 * - `read_uncommitted` (level 0): Allows dirty reads
 * - `read_committed` (level 1): Default. Only reads committed data
 * - `repeatable_read` (level 2): Prevents non-repeatable reads
 * - `serializable` (level 3): Full isolation
 */
export type SybaseIsolationLevel =
  | "read_uncommitted"
  | "read_committed"
  | "repeatable_read"
  | "serializable";

/** Map isolation level names to Sybase numeric levels. */
const isolationLevelMap: Record<SybaseIsolationLevel, number> = {
  read_uncommitted: 0,
  read_committed: 1,
  repeatable_read: 2,
  serializable: 3
};

// ---------------------------------------------------------------------------
// Transaction options
// ---------------------------------------------------------------------------

/**
 * Options for configuring a transaction.
 */
export interface SybaseTransactionOptions {
  /** Transaction isolation level. Default: uses server default (read_committed). */
  isolationLevel?: SybaseIsolationLevel;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SybaseSessionQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  affectedRows: number;
}

/**
 * The options of a session query: datetime columns decode to `Date` in the
 * session's zone, unconditionally. `timeZone` selects which wall clock the
 * stored values are read in, it does not decide whether they are decoded at
 * all. A driver that returned `Date` or `string` depending on configuration
 * would make every consumer handle a union that the schema does not describe.
 */
const inZone = (options: SybaseQueryOptions | undefined, timeZone: string): SybaseQueryOptions => ({
  ...options,
  timeZone
});

/** Project a result onto the narrower shape `execute` returns. */
const toSessionResult = <T>(result: QueryResult<T>): SybaseSessionQueryResult<T> => ({
  rows: result.rows,
  rowCount: result.rowCount,
  affectedRows: result.affectedRows
});

const TRANSACTION_ABORTED =
  "Transaction was rolled back by the server after an earlier statement failed";

const TRANSACTION_ENDED =
  "The transaction was ended by a statement inside it (e.g. a procedure that commits or rolls " +
  "back): work before that statement may already be committed, and nothing more may run in it. " +
  "End a transaction by returning from (or throwing in) the db.transaction() callback.";

/**
 * COMMIT only the transaction this session opened.
 *
 * ASE rolls a transaction back on its own after some errors (conversion
 * errors, deadlocks, ...), and a raw `commit`/`rollback` inside the callback
 * ends it too. A plain COMMIT TRAN with nothing open succeeds silently, so the
 * caller would be told everything committed. A nested BEGIN left open would
 * likewise survive a single COMMIT and go back to the pool still holding locks.
 */
const COMMIT_SQL = `if @@trancount = 1 commit tran
else begin
  if @@trancount > 0 rollback tran
  raiserror 20000 'drizzle-sybase: transaction ended early or was left nested; not committed'
end`;

/** Prefix for the savepoints taken by {@link SybaseTransactionSession.executeAtomic}. */
const ATOMIC_SAVEPOINT_PREFIX = "drizzle_sybase_sp_";

export class SybaseSession {
  private readonly timeZone: string;

  constructor(
    private readonly pool: SybasePool,
    timeZone?: string
  ) {
    this.timeZone = resolveTimeZone(timeZone);
  }

  /**
   * Execute raw SQL and return results.
   */
  async execute<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseSessionQueryResult<T>> {
    return toSessionResult(await this.pool.query<T>(rawSql, inZone(options, this.timeZone)));
  }

  /**
   * Execute raw SQL and return the full result (including columns).
   */
  async executeRaw(rawSql: string, options?: SybaseQueryOptions): Promise<QueryResult> {
    return this.pool.query(rawSql, inZone(options, this.timeZone));
  }

  /**
   * Execute raw SQL and return the result column by column — for bulk reads
   * (exports, Arrow / DuckDB / Parquet writers), where building an object per
   * row is most of the cost. Values decode as in {@link execute}; see
   * `SybaseColumnValues` for the array type of each column.
   */
  async executeColumns(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseColumnarResult> {
    return this.pool.queryColumns(rawSql, inZone(options, this.timeZone));
  }

  /**
   * Execute a multi-statement batch all-or-nothing.
   *
   * ASE commits each statement of a batch as it runs and carries on past
   * statement-level errors, so a batch that fails partway would leave the
   * statements before (and possibly after) the failure applied. Running it in
   * a transaction makes it atomic.
   */
  async executeAtomic<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string
  ): Promise<SybaseSessionQueryResult<T>> {
    return this.transaction(tx => tx.execute<T>(rawSql));
  }

  /**
   * Run a transaction on a single connection.
   *
   * Acquires a connection, optionally sets isolation level, executes BEGIN TRAN,
   * runs the callback, then COMMIT or ROLLBACK. The connection is held for the duration.
   *
   * @example
   * ```ts
   * await session.transaction(async tx => {
   *   await tx.execute("INSERT INTO ...");
   * }, { isolationLevel: "serializable" });
   * ```
   */
  async transaction<T>(
    fn: (tx: SybaseTransactionSession) => Promise<T>,
    options?: SybaseTransactionOptions
  ): Promise<T> {
    const conn = await this.pool.acquire();
    let tx: SybaseTransactionSession | undefined;
    try {
      // The isolation level applies to the transaction begun in the same batch.
      const level = options?.isolationLevel ? isolationLevelMap[options.isolationLevel] : undefined;
      await conn.query(
        level === undefined ? "BEGIN TRAN" : `SET TRANSACTION ISOLATION LEVEL ${level}\nBEGIN TRAN`
      );
      tx = new SybaseTransactionSession(conn, this.pool.logger, this.timeZone);
      try {
        const result = await fn(tx);
        // Ended before COMMIT, not after: once the callback has returned, the
        // connection is about to go back to the pool, and a kept reference to
        // `tx` must not run on it inside someone else's transaction. Anything
        // the callback started without awaiting is refused or finishes first.
        await tx.end();
        // The callback caught a statement error that made the server roll the
        // transaction back. Committing would report success for work that is
        // gone (and for anything run afterwards in autocommit).
        if (tx.abortReason) {
          throw new SybaseError(tx.abortReason);
        }
        await conn.query(COMMIT_SQL);
        return result;
      } catch (err) {
        await tx.end();
        // Attempt rollback — ignore errors if connection is dead
        try {
          await conn.query("ROLLBACK TRAN");
        } catch {
          // An alive socket says nothing about @@trancount: the transaction may
          // still be open, so the connection must not be reused. Closing it
          // makes release() discard it.
          conn.close();
        }
        throw err;
      }
    } finally {
      // The isolation level persists on the connection, and so does anything a
      // raw statement in the callback changed (ROWCOUNT, isolation, ...); none
      // of it may reach the next pool user. A transaction that touched neither
      // pays no extra round-trip: a statement that fails inside it already
      // resets ROWCOUNT (see SybaseTransactionSession).
      if ((options?.isolationLevel || tx?.touchedSessionState) && conn.isConnected) {
        try {
          await conn.resetSessionState();
        } catch {
          // State is unknown — discard rather than hand it to the next user.
          conn.close();
        }
      }
      // After the reset and COMMIT/ROLLBACK: dropped inside the transaction, a
      // table would come back on rollback.
      if (tx?.mayHaveCreatedTempTables && conn.isConnected) {
        try {
          await conn.dropTempTables();
        } catch {
          conn.close();
        }
      }
      if (tx?.discardConnection) {
        conn.close();
      }
      this.pool.release(conn);
    }
  }

  /**
   * Run `fn` with one connection to itself, outside any transaction.
   *
   * For work that spans several statements on the same session without being
   * one transaction — typically `#temp` tables, which ASE only lets a
   * transaction create when `ddl in tran` is enabled, and which a pool query
   * drops when it finishes. Each statement autocommits as usual.
   *
   * When `fn` settles the connection goes back to the pool in its baseline
   * state: `#temp` tables are dropped, session options reset, and a
   * transaction left open is rolled back and reported as an error.
   */
  async withConnection<T>(fn: (session: SybaseConnectionSession) => Promise<T>): Promise<T> {
    const conn = await this.pool.acquire();
    const session = new SybaseConnectionSession(conn, this.pool.logger, this.timeZone);
    let result: T;
    try {
      result = await fn(session);
    } catch (err) {
      await session.end();
      await this.releasePinned(conn, session);
      throw err;
    }
    // Finishes anything `fn` started without awaiting, and refuses later use
    // of `session`: the connection may already be someone else's.
    await session.end();
    const leftOpen = await this.releasePinned(conn, session);
    if (leftOpen) {
      throw new SybaseError(
        "withConnection() left a transaction open (or chained mode on); it was rolled back. " +
          "Use db.transaction() for transactions."
      );
    }
    return result;
  }

  /**
   * Return a {@link withConnection} connection to the pool in its baseline
   * state. Resolves to whether a transaction was left open; a connection whose
   * state cannot be established is discarded.
   */
  private async releasePinned(
    conn: SybaseConnection,
    session: SybaseConnectionSession
  ): Promise<boolean> {
    let leftOpen = false;
    try {
      if (conn.isConnected) {
        leftOpen = (await conn.resetSessionState()).leftOpen;
      }
      // After the reset: a drop inside the transaction it rolls back would be undone.
      if (session.mayHaveCreatedTempTables && conn.isConnected) {
        await conn.dropTempTables();
      }
    } catch {
      conn.close();
    }
    if (session.discardConnection) {
      conn.close();
    }
    this.pool.release(conn);
    return leftOpen;
  }
}

// ---------------------------------------------------------------------------
// Connection session — one held connection, no transaction
// ---------------------------------------------------------------------------

/** The session {@link SybaseSession.withConnection} hands its callback. */
export class SybaseConnectionSession {
  private ended = false;
  /** Operations run one at a time, as in {@link SybaseTransactionSession}. */
  private queue: Promise<unknown> = Promise.resolve();
  private _discardConnection = false;
  private _mayHaveCreatedTempTables = false;

  constructor(
    private readonly conn: SybaseConnection,
    private readonly logger: SybaseLogger | undefined,
    private readonly timeZone: string
  ) {}

  /** @internal Refuse further statements; settles once the current one has finished. */
  async end(): Promise<void> {
    this.ended = true;
    await this.queue;
  }

  /** @internal See {@link SybaseTransactionSession.discardConnection}. */
  get discardConnection(): boolean {
    return this._discardConnection;
  }

  /** @internal See {@link SybaseTransactionSession.mayHaveCreatedTempTables}. */
  get mayHaveCreatedTempTables(): boolean {
    return this._mayHaveCreatedTempTables;
  }

  async execute<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseSessionQueryResult<T>> {
    return toSessionResult(await this.serialize(() => this.run<T>(rawSql, options)));
  }

  async executeRaw(rawSql: string, options?: SybaseQueryOptions): Promise<QueryResult> {
    return this.serialize(() => this.run(rawSql, options));
  }

  /** See {@link SybaseSession.executeColumns}. */
  async executeColumns(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseColumnarResult> {
    return this.serialize(() =>
      this.runWith(rawSql, false, () =>
        this.conn.queryColumns(rawSql, inZone(options, this.timeZone))
      )
    );
  }

  /**
   * Execute a multi-statement batch all-or-nothing: in a transaction of its
   * own, or under a savepoint if the caller has opened one with raw SQL.
   */
  async executeAtomic<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string
  ): Promise<SybaseSessionQueryResult<T>> {
    return toSessionResult(
      await this.serialize(async () => {
        const { rows } = await this.run<Record<string, unknown>>(
          "select @@trancount as tc",
          undefined,
          true
        );
        const nested = (readServerInt(rows, "tc") ?? 0) > 0;
        const savepoint = `${ATOMIC_SAVEPOINT_PREFIX}1`;
        await this.run(nested ? `save tran ${savepoint}` : "BEGIN TRAN", undefined, true);
        try {
          const result = await this.run<T>(rawSql);
          if (!nested) {
            await this.run(COMMIT_SQL, undefined, true);
          }
          return result;
        } catch (err) {
          if (this.conn.isConnected) {
            try {
              await this.conn.query(
                nested
                  ? `if @@trancount > 0 rollback tran ${savepoint}`
                  : "if @@trancount > 0 rollback tran"
              );
            } catch {
              // Partial work may remain — abandon the connection.
              this.conn.close();
            }
          }
          throw err;
        }
      })
    );
  }

  /** Run `op` after every operation queued before it has settled. */
  private serialize<R>(op: () => Promise<R>): Promise<R> {
    const task = this.queue.then(op);
    this.queue = task.catch(() => {});
    return task;
  }

  /** One statement, with logging. Callers must hold the queue. */
  private async run<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: SybaseQueryOptions,
    /** Issued by this class itself, so known not to leave state behind. */
    internal = false
  ): Promise<QueryResult<T>> {
    return this.runWith(rawSql, internal, () =>
      this.conn.query<T>(rawSql, inZone(options, this.timeZone))
    );
  }

  /** {@link run}, with the statement executed by `execute`. */
  private async runWith<R extends { rowCount: number }>(
    rawSql: string,
    internal: boolean,
    execute: () => Promise<R>
  ): Promise<R> {
    if (this.ended) {
      throw new SybaseError("withConnection() has ended; statements must run inside its callback");
    }
    if (!this.conn.isConnected) {
      throw new SybaseConnectionError("Connection is dead");
    }
    if (!internal && mayChangeIdentity(rawSql)) {
      this._discardConnection = true;
    }
    if (!internal && mayCreateTempTable(rawSql)) {
      this._mayHaveCreatedTempTables = true;
    }
    const startTime = Date.now();
    try {
      const result = await execute();
      emitQueryLog(this.logger, {
        sql: rawSql,
        durationMs: Date.now() - startTime,
        rowCount: result.rowCount,
        timestamp: new Date(startTime)
      });
      return result;
    } catch (err) {
      emitQueryLog(this.logger, {
        sql: rawSql,
        durationMs: Date.now() - startTime,
        rowCount: 0,
        error: err instanceof Error ? err : new Error(String(err)),
        timestamp: new Date(startTime)
      });
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Transaction session — executes on a single held connection
// ---------------------------------------------------------------------------

export class SybaseTransactionSession {
  private readonly timeZone: string;
  private ended = false;
  /** Why the transaction can no longer be used, once it cannot. */
  private _abortReason: string | undefined;
  /**
   * Tail of the operations run on this transaction, one at a time.
   *
   * The connection already serializes single queries, but an operation here is
   * several: the statement, then the reset that finds out whether the server
   * rolled the transaction back (and, for {@link executeAtomic}, a savepoint
   * around both). Interleaved with another operation's queries, a statement
   * queued behind a failure would run after the rollback — in autocommit — and
   * a savepoint rollback could undo another caller's work.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private savepoints = 0;
  private _touchedSessionState = false;
  private _discardConnection = false;
  private _mayHaveCreatedTempTables = false;

  constructor(
    private readonly conn: SybaseConnection,
    private readonly logger?: SybaseLogger,
    timeZone?: string
  ) {
    this.timeZone = resolveTimeZone(timeZone);
  }

  /**
   * @internal Called by {@link SybaseSession.transaction} when the callback
   * settles. Operations already queued are refused; the returned promise
   * settles once the one in progress (if any) has finished, so nothing runs on
   * the connection after COMMIT/ROLLBACK.
   */
  async end(): Promise<void> {
    this.ended = true;
    await this.queue;
  }

  /**
   * Whether the transaction has ended underneath the callback — rolled back by
   * the server after a failed statement, or ended by a statement in it.
   * Further statements are refused: they would run in autocommit mode.
   */
  get aborted(): boolean {
    return this._abortReason !== undefined;
  }

  /** @internal Why {@link aborted} is set. */
  get abortReason(): string | undefined {
    return this._abortReason;
  }

  /**
   * @internal Whether a statement may have changed session state that outlives
   * the transaction (see `mayLeaveSessionState`), so the connection needs a
   * reset before it goes back to the pool.
   */
  get touchedSessionState(): boolean {
    return this._touchedSessionState;
  }

  /**
   * @internal A statement may have switched the session's identity
   * (`setuser`), which cannot be restored, so the connection must be discarded
   * when the transaction ends.
   */
  get discardConnection(): boolean {
    return this._discardConnection;
  }

  /**
   * @internal A statement may have created a `#temp` table, which must not
   * outlive the transaction on a pooled connection.
   */
  get mayHaveCreatedTempTables(): boolean {
    return this._mayHaveCreatedTempTables;
  }

  /**
   * Execute raw SQL within the transaction.
   */
  async execute<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseSessionQueryResult<T>> {
    return toSessionResult(await this.serialize(() => this.run<T>(rawSql, options)));
  }

  async executeRaw(rawSql: string, options?: SybaseQueryOptions): Promise<QueryResult> {
    return this.serialize(() => this.run(rawSql, options));
  }

  /** See {@link SybaseSession.executeColumns}. */
  async executeColumns(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseColumnarResult> {
    return this.serialize(() =>
      this.runWith(rawSql, false, () =>
        this.conn.queryColumns(rawSql, inZone(options, this.timeZone))
      )
    );
  }

  /**
   * Execute a multi-statement batch all-or-nothing, without ending the
   * enclosing transaction.
   *
   * ASE carries on with the rest of a batch after a statement-level error such
   * as a duplicate key, so a caller that catches the error would otherwise
   * commit the statements around the failed one. A savepoint taken first (in
   * its own round-trip: a batch that fails to compile never runs it) lets just
   * this batch be undone. Each call gets its own savepoint name.
   */
  async executeAtomic<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string
  ): Promise<SybaseSessionQueryResult<T>> {
    return toSessionResult(
      await this.serialize(async () => {
        const savepoint = `${ATOMIC_SAVEPOINT_PREFIX}${++this.savepoints}`;
        await this.run(`save tran ${savepoint}`, undefined, true);
        try {
          return await this.run<T>(rawSql);
        } catch (err) {
          if (!this.aborted && this.conn.isConnected) {
            try {
              await this.conn.query(`rollback tran ${savepoint}`);
            } catch {
              // Partial work may remain in the transaction — abandon it.
              this.conn.close();
            }
          }
          throw err;
        }
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Run `op` after every operation queued before it has settled. */
  private serialize<R>(op: () => Promise<R>): Promise<R> {
    const task = this.queue.then(op);
    this.queue = task.catch(() => {});
    return task;
  }

  /** One statement, with logging and failure cleanup. Callers must hold the queue. */
  private async run<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: SybaseQueryOptions,
    /** Issued by this class itself, so known not to leave state behind. */
    internal = false
  ): Promise<QueryResult<T>> {
    return this.runWith(rawSql, internal, () =>
      this.conn.query<T>(rawSql, inZone(options, this.timeZone))
    );
  }

  /** {@link run}, with the statement executed by `execute`. */
  private async runWith<R extends { rowCount: number }>(
    rawSql: string,
    internal: boolean,
    execute: () => Promise<R>
  ): Promise<R> {
    if (this.ended) {
      throw new SybaseError(
        "Transaction has already ended; statements must run inside the transaction callback"
      );
    }
    if (this._abortReason) {
      throw new SybaseError(this._abortReason);
    }
    // Refused before it is sent: once a COMMIT/ROLLBACK runs, the rest of its
    // batch would run in autocommit, beyond anything a later check can undo.
    if (!internal && endsTransaction(rawSql)) {
      throw new SybaseError(
        "COMMIT and ROLLBACK cannot run inside db.transaction(): the transaction ends when the " +
          "callback returns (commit) or throws (rollback). Savepoints (`save tran x` / " +
          "`rollback tran x`) are allowed."
      );
    }
    if (!this.conn.isConnected) {
      throw new SybaseConnectionError("Transaction connection is dead");
    }
    const startTime = Date.now();
    const checkState = !internal && mayLeaveSessionState(rawSql);
    if (checkState) {
      this._touchedSessionState = true;
    }
    if (!internal && mayChangeIdentity(rawSql)) {
      this._discardConnection = true;
    }
    if (!internal && mayCreateTempTable(rawSql)) {
      this._mayHaveCreatedTempTables = true;
    }
    let result: R;
    try {
      result = await execute();
      emitQueryLog(this.logger, {
        sql: rawSql,
        durationMs: Date.now() - startTime,
        rowCount: result.rowCount,
        timestamp: new Date(startTime)
      });
    } catch (err) {
      emitQueryLog(this.logger, {
        sql: rawSql,
        durationMs: Date.now() - startTime,
        rowCount: 0,
        error: err instanceof Error ? err : new Error(String(err)),
        timestamp: new Date(startTime)
      });
      await this.afterFailure();
      throw err;
    }
    // A statement that can end a transaction — a raw COMMIT / ROLLBACK, or a
    // procedure that runs one — succeeds without telling us. Everything after
    // it would run in autocommit, outside the transaction the caller thinks it
    // is in, and nothing at commit time could undo that. So confirm the
    // transaction is still open before the next statement may run.
    if (checkState) {
      await this.confirmStillOpen();
    }
    return result;
  }

  /** See {@link run}: refuse to continue once the transaction has ended. */
  private async confirmStillOpen(): Promise<void> {
    let trancount: number | undefined;
    try {
      const { rows } = await this.conn.query<Record<string, unknown>>("select @@trancount as tc");
      trancount = readServerInt(rows, "tc");
    } catch {
      // Handled below as unknown.
    }
    if (trancount === undefined) {
      this.conn.close();
      throw new SybaseError(
        "Could not confirm the transaction is still open after the statement; the connection " +
          "was discarded, rolling back the transaction"
      );
    }
    if (trancount === 0) {
      this._abortReason = TRANSACTION_ENDED;
      throw new SybaseError(TRANSACTION_ENDED);
    }
  }

  /**
   * Restore a usable, known session state after a failed statement.
   *
   * A failed raw batch can skip its trailing `SET ROWCOUNT 0`, and the
   * caller may catch the error and keep using the transaction — every later
   * statement would then be silently truncated. The same round-trip reads
   * `@@trancount` to learn whether the server rolled the transaction back. If
   * either cannot be established the state is unknown, so the connection is
   * closed (aborting the transaction) rather than used further.
   */
  private async afterFailure(): Promise<void> {
    if (!this.conn.isConnected) {
      return;
    }
    let trancount: number | undefined;
    try {
      const { rows } = await this.conn.query<Record<string, unknown>>(
        "SET ROWCOUNT 0\nselect @@trancount as tc"
      );
      trancount = readServerInt(rows, "tc");
    } catch {
      // Handled below as unknown.
    }
    if (trancount === undefined) {
      this.conn.close();
    } else if (trancount === 0) {
      this._abortReason = TRANSACTION_ABORTED;
    }
  }
}
