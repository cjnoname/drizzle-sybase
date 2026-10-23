/**
 * Sybase connection pool: sizing, health checks, idle cleanup, acquire
 * deadlines, retries, graceful drain, metrics, query logging — and the
 * guarantee that a connection returns to the pool in its baseline session
 * state.
 */
import {
  checkInteger,
  emitQueryLog,
  MAX_INT32,
  SybaseConnection,
  validateConnectionConfig,
  validateQueryOptions
} from "./connection.js";
import type {
  QueryResult,
  SybaseConnectionConfig,
  SybaseLogger,
  SybaseQueryOptions
} from "./connection.js";
import {
  SybaseError,
  SybaseConnectionError,
  SybaseTimeoutError,
  SybasePoolError
} from "./errors.js";
import {
  isReadOnlySql,
  mayChangeIdentity,
  mayCreateTempTable,
  mayLeaveSessionState
} from "./sql-classify.js";

export interface SybasePoolConfig extends SybaseConnectionConfig {
  /** Maximum connections in pool. Default: 5 */
  max?: number;
  /** Connection idle timeout in ms. Default: 60000 (60s) */
  idleTimeoutMs?: number;
  /** Connection acquire timeout in ms. Default: 10000 (10s) */
  acquireTimeoutMs?: number;
  /** How often to run idle cleanup in ms. Default: 30000 (30s) */
  cleanupIntervalMs?: number;
  /** Enable health check ping before returning connection from pool. Default: false */
  healthCheck?: boolean;
  /**
   * Max retries when a connection fails. Failing to open a connection is
   * retried for any statement, since nothing reached the server. Failing
   * mid-query is retried only for read-only statements (`select`, optionally
   * wrapped in `SET ROWCOUNT`); writes are never re-run, since the server may
   * already have applied them. Default: 2
   */
  retries?: number;
  /** Delay between retries in ms. Default: 500 */
  retryDelayMs?: number;
  /** Query logger callback. Called for every query executed through the pool. */
  logger?: SybaseLogger;
}

// ---------------------------------------------------------------------------
// Pool metrics
// ---------------------------------------------------------------------------

/**
 * Observable pool metrics for monitoring.
 */
export interface SybasePoolMetrics {
  /** Total connections ever created. */
  totalConnectionsCreated: number;
  /** Total connections that have been destroyed. */
  totalConnectionsDestroyed: number;
  /** Total queries executed through the pool. */
  totalQueriesExecuted: number;
  /** Total query errors encountered. */
  totalQueryErrors: number;
  /** Total acquire timeouts. */
  totalAcquireTimeouts: number;
  /** Average query duration in ms (rolling). */
  avgQueryDurationMs: number;
  /** Current pool size. */
  currentSize: number;
  /** Current active (in-use) connections. */
  currentActive: number;
  /** Current idle connections. */
  currentIdle: number;
  /** Current queue length. */
  currentWaiting: number;
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

interface PooledConnection {
  conn: SybaseConnection;
  lastUsed: number;
  createdAt: number;
  inUse: boolean;
}

interface Waiter {
  resolve: (conn: SybaseConnection) => void;
  reject: (err: Error) => void;
}

/**
 * Production-grade connection pool for Sybase ASE.
 *
 * Features:
 * - max pool sizing with automatic scaling
 * - Health checks (dead connection detection + optional ping)
 * - Idle connection cleanup
 * - Acquire timeout with fair queuing
 * - Retry on transient connection failures
 * - Graceful drain/shutdown
 * - Observable metrics for monitoring
 * - Query logging middleware
 *
 * @example
 * ```ts
 * const pool = new SybasePool({
 *   host: "sybase-host",
 *   port: 5000,
 *   database: "mydb",
 *   username: "sa",
 *   password: "secret",
 *   max: 10,
 *   logger: { query(log) { console.log(`[${log.durationMs}ms] ${log.sql}`); } }
 * });
 *
 * const result = await pool.query("SELECT 1 AS val");
 * console.log(pool.metrics);
 * await pool.drain();
 * ```
 */
export class SybasePool {
  private pool: PooledConnection[] = [];
  private waitQueue: Waiter[] = [];
  private closed = false;
  private draining = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cfg: Required<
    Omit<
      SybasePoolConfig,
      "logger" | "packetSize" | "hardTimeoutMs" | "timeZone" | "warnOnTimeZoneMismatch"
    >
  > & {
    logger?: SybaseLogger;
    packetSize?: number;
    hardTimeoutMs?: number;
    timeZone?: string;
    warnOnTimeZoneMismatch?: boolean;
  };

  // Metrics tracking
  private _totalConnectionsCreated = 0;
  private _totalConnectionsDestroyed = 0;
  private _totalQueriesExecuted = 0;
  private _totalQueryErrors = 0;
  private _totalAcquireTimeouts = 0;
  private _queryDurationSum = 0;
  private _queryDurationCount = 0;
  private _activeCount = 0;
  /** Number of connections currently being created (prevents exceeding max). */
  private _pendingCreates = 0;

  constructor(config: SybasePoolConfig) {
    const max = config.max ?? 5;

    if (!(Number.isInteger(max) && max >= 1)) {
      throw new SybasePoolError(`Pool max must be at least 1, got ${String(max)}`, "closed");
    }

    // Before the cleanup timer is started, so a bad option cannot leave a
    // half-built pool behind.
    validateConnectionConfig(config);
    checkInteger("idleTimeoutMs", config.idleTimeoutMs, 1, MAX_INT32);
    checkInteger("acquireTimeoutMs", config.acquireTimeoutMs, 1, MAX_INT32);
    checkInteger("cleanupIntervalMs", config.cleanupIntervalMs, 1, MAX_INT32);
    checkInteger("retries", config.retries, 0, 100);
    checkInteger("retryDelayMs", config.retryDelayMs, 0, MAX_INT32);

    this.cfg = {
      ...config,
      timeout: config.timeout ?? 30,
      max,
      idleTimeoutMs: config.idleTimeoutMs ?? 60000,
      acquireTimeoutMs: config.acquireTimeoutMs ?? 10000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 30000,
      healthCheck: config.healthCheck ?? false,
      retries: config.retries ?? 2,
      retryDelayMs: config.retryDelayMs ?? 500,
      logger: config.logger
    };

    // Start idle cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdle();
    }, this.cfg.cleanupIntervalMs);

    // Unref so it doesn't keep the process alive
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Acquire a connection from the pool.
   * - Validates existing connections (health check)
   * - Creates new connections up to `max`
   * - Queues if pool is full
   *
   * `acquireTimeoutMs` bounds the whole call — waiting in the queue, but also
   * opening a connection and the health check. A connection that arrives after
   * the caller gave up goes back to the pool.
   */
  async acquire(): Promise<SybaseConnection> {
    if (this.closed || this.draining) {
      throw this.unavailableError();
    }
    const timeoutMs = this.cfg.acquireTimeoutMs;
    return new Promise<SybaseConnection>((resolve, reject) => {
      let settled = false;
      let queued: Waiter | undefined;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        if (queued) {
          const idx = this.waitQueue.indexOf(queued);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
          }
        }
        this._totalAcquireTimeouts++;
        reject(
          new SybaseTimeoutError(
            `Connection acquire timeout after ${timeoutMs}ms`,
            "acquire",
            timeoutMs
          )
        );
      }, timeoutMs);
      this.claim(waiter => {
        queued = waiter;
      }).then(
        conn => {
          clearTimeout(timer);
          if (settled) {
            this.release(conn);
            return;
          }
          settled = true;
          resolve(conn);
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      );
    });
  }

  /** Get a connection by any means, without a deadline; see {@link acquire}. */
  private async claim(onQueued: (waiter: Waiter) => void): Promise<SybaseConnection> {
    if (this.closed || this.draining) {
      throw this.unavailableError();
    }

    // Try to find an idle, healthy connection
    for (let i = 0; i < this.pool.length; i++) {
      const pooled = this.pool[i];
      if (!pooled.inUse) {
        // Check if connection is still alive
        if (!pooled.conn.isConnected) {
          // Dead connection — remove and continue
          this.removeFromPool(i);
          i--;
          continue;
        }

        // Claim before the health check: it awaits, and a concurrent acquire()
        // must not hand out the same connection in the meantime.
        pooled.inUse = true;
        pooled.lastUsed = Date.now();
        this._activeCount++;

        // Optional health check (lightweight query)
        if (this.cfg.healthCheck) {
          try {
            await pooled.conn.query("SELECT 1");
          } catch {
            // Health check failed — the pool may have changed during the await
            // (or been closed), so locate the entry again rather than trusting `i`.
            const idx = this.pool.indexOf(pooled);
            if (idx !== -1) {
              this._activeCount--;
              this.removeFromPool(idx);
              this.checkDrainComplete();
            }
            return this.claim(onQueued);
          }

          // The pool may have been closed or started draining during the
          // check. close() has already closed the connection; under drain,
          // hand it back so the drain can complete.
          if (this.closed || this.draining) {
            this.release(pooled.conn);
            throw this.unavailableError();
          }
        }

        return pooled.conn;
      }
    }

    // Can we create a new connection?
    if (this.pool.length + this._pendingCreates < this.cfg.max) {
      this._pendingCreates++;
      let conn: SybaseConnection;
      try {
        conn = await this.createConnection();
      } catch (err) {
        this._pendingCreates--;
        // The slot this attempt held is free again: give a queued caller its
        // own attempt now rather than leave it waiting out its timeout.
        void this.serveWaiter();
        throw err;
      }
      this._pendingCreates--;

      // Re-check after async gap: the pool may have been closed or started
      // draining, and nothing would ever close a connection added now.
      if (this.closed || this.draining) {
        conn.close();
        this._totalConnectionsDestroyed++;
        throw this.unavailableError();
      }

      // Another acquire may have filled the pool
      if (this.pool.length >= this.cfg.max) {
        // Pool is full now — close the extra connection
        conn.close();
        this._totalConnectionsDestroyed++;
        // Fall through to wait queue below
      } else {
        const pooled: PooledConnection = {
          conn,
          lastUsed: Date.now(),
          createdAt: Date.now(),
          inUse: true
        };
        this._activeCount++;
        this.pool.push(pooled);
        return conn;
      }
    }

    // Pool full — wait for one to become available. acquire() owns the
    // deadline and takes the waiter out of the queue if it passes.
    return new Promise<SybaseConnection>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      this.waitQueue.push(waiter);
      onQueued(waiter);
    });
  }

  /**
   * Release a connection back to the pool.
   */
  release(conn: SybaseConnection): void {
    const pooled = this.pool.find(p => p.conn === conn);
    if (!pooled || !pooled.inUse) {
      // Already released or not in pool — ignore
      return;
    }

    pooled.inUse = false;
    pooled.lastUsed = Date.now();
    this._activeCount--;

    // Session state is reset by query() before release, never here: an async
    // reset could run concurrently with the next user's query.

    // If connection died during use, remove it
    if (!conn.isConnected) {
      const idx = this.pool.indexOf(pooled);
      if (idx !== -1) {
        this.pool.splice(idx, 1);
        conn.close();
        this._totalConnectionsDestroyed++;
      }
      // Try to serve a waiter with a new connection (only if not draining)
      if (this.draining) {
        this.checkDrainComplete();
      } else {
        void this.serveWaiter();
      }
      return;
    }

    // If draining and no in-use connections, we're done
    if (this.draining) {
      this.checkDrainComplete();
      return;
    }

    // If someone is waiting, give them this connection
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      pooled.inUse = true;
      pooled.lastUsed = Date.now();
      this._activeCount++;
      waiter.resolve(conn);
    }
  }

  /**
   * Execute a query using a pooled connection (auto acquire/release).
   *
   * Read-only statements are retried on transient connection failures. Anything
   * else is not: a connection that dies mid-statement may already have applied
   * it on the server, so re-running it could repeat a write.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    options?: SybaseQueryOptions
  ): Promise<QueryResult<T>> {
    // Classified only when a retry is actually possible: scanning every
    // statement up front would cost a full pass over large batches on the
    // common path, where nothing fails.
    let readOnly: boolean | undefined;
    validateQueryOptions(options);

    for (let attempt = 0; ; attempt++) {
      let conn: SybaseConnection;
      try {
        conn = await this.acquire();
      } catch (err) {
        // Nothing reached the server, so even a write is safe to try again.
        if (err instanceof SybaseConnectionError && attempt < this.cfg.retries) {
          await this.delay(this.cfg.retryDelayMs);
          continue;
        }
        throw err;
      }
      const startTime = Date.now();
      /** Set when the statement succeeded but left the session in a state that had to be undone. */
      let stateError: SybaseError | undefined;
      try {
        const result = await conn.query<T>(sql, options);
        const durationMs = Date.now() - startTime;
        this._totalQueriesExecuted++;
        this._queryDurationSum += durationMs;
        this._queryDurationCount++;
        emitQueryLog(this.cfg.logger, {
          sql,
          durationMs,
          rowCount: result.rowCount,
          timestamp: new Date(startTime)
        });
        // Each pool query may land on a different connection, so a
        // transaction opened here can never be committed by a later one; left
        // open it would hold its locks and swallow the next user's writes.
        const leftOpen = mayLeaveSessionState(sql) ? await this.resetOrDiscard(conn) : false;
        // After the reset: a drop inside a transaction it rolls back would be undone.
        await this.dropTempTablesOrDiscard(conn, sql);
        this.discardIfIdentityChanged(conn, sql);
        if (leftOpen === false) {
          return result;
        }
        stateError = new SybaseError(
          leftOpen
            ? "The statement left a transaction open (or enabled chained mode); it was rolled " +
                "back. Use db.transaction() for multi-statement transactions."
            : "The statement succeeded, but the session state could not be verified afterwards; " +
                "the connection was discarded, rolling back any transaction it left open."
        );
      } catch (err: any) {
        this._totalQueryErrors++;
        emitQueryLog(this.cfg.logger, {
          sql,
          durationMs: Date.now() - startTime,
          rowCount: 0,
          error: err instanceof Error ? err : new Error(String(err)),
          timestamp: new Date(startTime)
        });

        // A failed raw batch can skip its trailing `SET ROWCOUNT 0`, and a
        // raw batch that opened a transaction and then failed may have left it
        // open, holding its locks.
        await this.resetOrDiscard(conn);
        await this.dropTempTablesOrDiscard(conn, sql);
        this.discardIfIdentityChanged(conn, sql);

        if (
          !(err instanceof SybaseConnectionError) ||
          attempt >= this.cfg.retries ||
          !(readOnly ??= isReadOnlySql(sql))
        ) {
          throw err;
        }
      } finally {
        this.release(conn);
      }
      if (stateError) {
        throw stateError;
      }
      // Transient failure on a read-only statement — retry after delay
      await this.delay(this.cfg.retryDelayMs);
    }
  }

  /**
   * Drop the `#temp` tables a pool query may have created (see
   * {@link SybaseConnection.dropTempTables}): the next query may land on
   * another connection, so they cannot be used again, and the next user of
   * this one must not find them. If that fails the connection is discarded.
   */
  private async dropTempTablesOrDiscard(conn: SybaseConnection, sql: string): Promise<void> {
    if (!mayCreateTempTable(sql) || !conn.isConnected) {
      return;
    }
    try {
      await conn.dropTempTables();
    } catch {
      conn.close();
    }
  }

  /**
   * Discard a connection that may have run `setuser`: its identity cannot be
   * restored to a known baseline (see {@link mayChangeIdentity}), so release()
   * must not hand it to the next user.
   */
  private discardIfIdentityChanged(conn: SybaseConnection, sql: string): void {
    if (mayChangeIdentity(sql)) {
      conn.close();
    }
  }

  /**
   * Bring a connection back to its baseline session state before it returns
   * to the pool (see {@link SybaseConnection.resetSessionState}).
   *
   * Resolves to whether a transaction was left open, or `undefined` when the
   * state could not be established — the connection is then closed so that
   * release() discards it.
   */
  private async resetOrDiscard(conn: SybaseConnection): Promise<boolean | undefined> {
    if (!conn.isConnected) {
      return undefined;
    }
    try {
      return (await conn.resetSessionState()).leftOpen;
    } catch {
      conn.close();
      return undefined;
    }
  }

  /**
   * Gracefully drain the pool — finish all in-flight operations, then close.
   *
   * New acquire() calls will be rejected immediately.
   * Returns a promise that resolves when all active connections are released.
   *
   * @param timeoutMs - Maximum time to wait for drain. Default: 30000ms
   */
  async drain(timeoutMs = 30000): Promise<void> {
    if (this.closed) {
      return;
    }
    // Concurrent callers share one drain; a second timer or callback would
    // leave the first caller waiting.
    if (this.drainPromise) {
      return this.drainPromise;
    }
    this.draining = true;

    // Reject all waiters immediately
    for (const waiter of this.waitQueue) {
      waiter.reject(new SybasePoolError("Pool is draining", "draining"));
    }
    this.waitQueue = [];

    // Settled by close(), whichever path triggers it: the last release, the
    // timeout, or a direct close() call.
    this.drainPromise = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // Force close after timeout
        void this.close();
      }, timeoutMs);

      if (typeof timer.unref === "function") {
        timer.unref();
      }

      this.settleDrain = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    // No active connections — close immediately
    this.checkDrainComplete();
    return this.drainPromise;
  }

  private drainPromise: Promise<void> | null = null;
  private settleDrain?: () => void;

  private checkDrainComplete(): void {
    if (this.draining && this.active === 0) {
      void this.close();
    }
  }

  /**
   * Close all connections and shut down the pool.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.draining = false;

    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Reject all waiters
    for (const waiter of this.waitQueue) {
      waiter.reject(new SybasePoolError("Pool is closing", "closed"));
    }
    this.waitQueue = [];

    // Close all connections
    for (const pooled of this.pool) {
      pooled.conn.close();
      this._totalConnectionsDestroyed++;
    }
    this.pool = [];
    this._activeCount = 0;

    // Settle a pending drain() — the pool it was waiting on is now closed.
    const settle = this.settleDrain;
    this.settleDrain = undefined;
    this.drainPromise = null;
    settle?.();
  }

  // ---------------------------------------------------------------------------
  // Pool state accessors
  // ---------------------------------------------------------------------------

  /** Number of total connections in the pool. */
  get size(): number {
    return this.pool.length;
  }

  /** Number of idle (available) connections. */
  get idle(): number {
    return this.pool.length - this._activeCount;
  }

  /** Number of active (in-use) connections. */
  get active(): number {
    return this._activeCount;
  }

  /** Number of waiters in queue. */
  get waiting(): number {
    return this.waitQueue.length;
  }

  /** Whether the pool is currently draining. */
  get isDraining(): boolean {
    return this.draining;
  }

  /** Whether the pool is closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** @internal Get the configured logger (if any). */
  get logger(): SybaseLogger | undefined {
    return this.cfg.logger;
  }

  /**
   * Get a snapshot of pool metrics for monitoring/observability.
   */
  get metrics(): SybasePoolMetrics {
    return {
      totalConnectionsCreated: this._totalConnectionsCreated,
      totalConnectionsDestroyed: this._totalConnectionsDestroyed,
      totalQueriesExecuted: this._totalQueriesExecuted,
      totalQueryErrors: this._totalQueryErrors,
      totalAcquireTimeouts: this._totalAcquireTimeouts,
      avgQueryDurationMs:
        this._queryDurationCount > 0
          ? Math.round(this._queryDurationSum / this._queryDurationCount)
          : 0,
      currentSize: this.size,
      currentActive: this.active,
      currentIdle: this.idle,
      currentWaiting: this.waiting
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async createConnection(): Promise<SybaseConnection> {
    const conn = new SybaseConnection(this.cfg);
    await conn.connect();
    this._totalConnectionsCreated++;
    return conn;
  }

  private removeFromPool(index: number): void {
    const removed = this.pool.splice(index, 1)[0];
    if (removed) {
      removed.conn.close();
      this._totalConnectionsDestroyed++;
    }
  }

  private unavailableError(): SybasePoolError {
    return this.closed
      ? new SybasePoolError("Pool is closed", "closed")
      : new SybasePoolError("Pool is draining — no new connections allowed", "draining");
  }

  private async serveWaiter(): Promise<void> {
    if (
      this.waitQueue.length === 0 ||
      this.closed ||
      this.draining ||
      this.pool.length + this._pendingCreates >= this.cfg.max
    ) {
      return;
    }

    this._pendingCreates++;
    try {
      const conn = await this.createConnection();
      this._pendingCreates--;

      // close()/drain() rejected every waiter during the await; a connection
      // added now would never be closed.
      if (this.closed || this.draining) {
        conn.close();
        this._totalConnectionsDestroyed++;
        return;
      }

      const pooled: PooledConnection = {
        conn,
        lastUsed: Date.now(),
        createdAt: Date.now(),
        inUse: true
      };
      this._activeCount++;
      this.pool.push(pooled);

      // Re-check queue after async operation — waiter may have timed out
      const waiter = this.waitQueue.shift();
      if (waiter) {
        waiter.resolve(conn);
      } else {
        // No waiter left — release the connection back to idle
        pooled.inUse = false;
        this._activeCount--;
      }
    } catch (err: any) {
      this._pendingCreates--;
      // Can't create connection — reject the first waiter if any
      const waiter = this.waitQueue.shift();
      if (waiter) {
        waiter.reject(err instanceof Error ? err : new SybaseError(String(err)));
      }
    }
  }

  /**
   * Remove idle connections that have exceeded the idle timeout.
   */
  private cleanupIdle(): void {
    const now = Date.now();
    let i = 0;

    while (i < this.pool.length) {
      const pooled = this.pool[i];
      const isIdle = !pooled.inUse;
      const isExpired = now - pooled.lastUsed > this.cfg.idleTimeoutMs;

      if (isIdle && isExpired) {
        this.removeFromPool(i);
        // Don't increment i — the array shifted
      } else {
        i++;
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
