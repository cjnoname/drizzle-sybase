import {
  SybaseError,
  SybaseConnectionError,
  SybaseQueryError,
  SybaseTimeoutError,
  SybasePoolError
} from "./errors.js";
/**
 * Sybase connection management with production-grade connection pooling.
 *
 * Features:
 * - Persistent db-lib connections via N-API
 * - Connection pool with min/max sizing
 * - Health checks (dead connection detection + optional ping)
 * - Idle connection cleanup
 * - Automatic reconnection for dead connections
 * - Acquire timeout with queuing
 * - Retry on transient failures
 * - Graceful drain/shutdown
 * - Observable pool metrics
 * - Query logging/middleware support
 */
import { native } from "./native/index.js";

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
}

export interface SybasePoolConfig extends SybaseConnectionConfig {
  /** Minimum connections to keep in pool. Default: 1 */
  min?: number;
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
  /** Max retries for transient connection failures. Default: 2 */
  retries?: number;
  /** Delay between retries in ms. Default: 500 */
  retryDelayMs?: number;
  /** Query logger callback. Called for every query executed through the pool. */
  logger?: SybaseLogger;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  columns: string[];
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
// Single connection
// ---------------------------------------------------------------------------

/**
 * A single Sybase connection wrapping the native FreeTDS handle.
 *
 * Normally you won't use this directly — use `SybasePool` instead.
 * This class manages the lifecycle of a single db-lib connection.
 */
export class SybaseConnection {
  private handle: unknown = null;
  private closed = false;
  private inUse = false;
  /** Promise queue to serialize queries on a single DBPROCESS (not thread-safe). */
  private queryQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: SybaseConnectionConfig) {}

  async connect(): Promise<void> {
    if (this.handle && !this.closed) {
      return;
    }
    this.closed = false;
    try {
      this.handle = await native.connect({
        ...this.config,
        timeout: this.config.timeout ?? 30
      });
    } catch (err: any) {
      throw new SybaseConnectionError(err.message ?? String(err), {
        host: this.config.host,
        port: this.config.port
      });
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    options?: { maxRows?: number }
  ): Promise<QueryResult<T>> {
    // Serialize queries on this connection — db-lib DBPROCESS is not reentrant.
    const task = this.queryQueue.then(() => this.executeQuery<T>(sql, options));
    // Update queue head; swallow rejections so subsequent queries still run.
    this.queryQueue = task.catch(() => {});
    return task;
  }

  private async executeQuery<T = Record<string, unknown>>(
    sql: string,
    options?: { maxRows?: number }
  ): Promise<QueryResult<T>> {
    if (!this.handle || this.closed) {
      throw new SybaseConnectionError("Connection is closed", {
        host: this.config.host,
        port: this.config.port
      });
    }
    try {
      return (await native.query(this.handle, sql, options)) as unknown as QueryResult<T>;
    } catch (err: any) {
      // Check if the error indicates a dead connection
      if (err && err.connectionDead) {
        this.closed = true;
        throw new SybaseConnectionError(err.message ?? String(err), {
          host: this.config.host,
          port: this.config.port
        });
      }
      throw new SybaseQueryError(err.message ?? String(err), {
        sql,
        connectionDead: false
      });
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

  /** @internal */
  get _inUse(): boolean {
    return this.inUse;
  }

  /** @internal */
  set _inUse(val: boolean) {
    this.inUse = val;
  }
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
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Production-grade connection pool for Sybase ASE.
 *
 * Features:
 * - Min/max pool sizing with automatic scaling
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
 *   min: 2,
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
  private readonly cfg: Required<Omit<SybasePoolConfig, "logger">> & { logger?: SybaseLogger };

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
    const min = config.min ?? 1;
    const max = config.max ?? 5;

    if (max < 1) {
      throw new SybasePoolError("Pool max must be at least 1", "closed");
    }
    if (min < 0) {
      throw new SybasePoolError("Pool min must be non-negative", "closed");
    }
    if (min > max) {
      throw new SybasePoolError(`Pool min (${min}) cannot exceed max (${max})`, "closed");
    }

    this.cfg = {
      ...config,
      timeout: config.timeout ?? 30,
      min,
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

    // Warm up pool to min connections (non-blocking)
    if (this.cfg.min > 0) {
      void this.warmUp();
    }
  }

  /**
   * Pre-create connections up to `min` size.
   * Runs in the background — failures are silently ignored
   * (connections will be created on demand instead).
   *
   * Note: warm-up does NOT use _pendingCreates to avoid blocking
   * concurrent acquire() calls during pool startup.
   */
  private async warmUp(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.cfg.min; i++) {
      promises.push(
        this.createConnection()
          .then(conn => {
            if (!this.closed && !this.draining && this.pool.length < this.cfg.max) {
              this.pool.push({
                conn,
                lastUsed: Date.now(),
                createdAt: Date.now(),
                inUse: false
              });
            } else {
              conn.close();
            }
          })
          .catch(() => {
            // Ignore warm-up failures — connections will be created on demand
          })
      );
    }
    await Promise.all(promises);
  }

  /**
   * Acquire a connection from the pool.
   * - Validates existing connections (health check)
   * - Creates new connections up to `max`
   * - Queues if pool is full
   */
  async acquire(): Promise<SybaseConnection> {
    if (this.closed) {
      throw new SybasePoolError("Pool is closed", "closed");
    }
    if (this.draining) {
      throw new SybasePoolError("Pool is draining — no new connections allowed", "draining");
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

        // Optional health check (lightweight query)
        if (this.cfg.healthCheck) {
          try {
            await pooled.conn.query("SELECT 1");
          } catch {
            // Health check failed — remove dead connection
            this.removeFromPool(i);
            i--;
            continue;
          }
        }

        pooled.inUse = true;
        pooled.conn._inUse = true;
        pooled.lastUsed = Date.now();
        this._activeCount++;
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
        throw err;
      }
      this._pendingCreates--;

      // Re-check after async gap: warm-up or another acquire may have filled pool
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
        conn._inUse = true;
        this._activeCount++;
        this.pool.push(pooled);
        return conn;
      }
    }

    // Pool full — wait for one to become available
    return new Promise<SybaseConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex(w => w.resolve === resolve);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        this._totalAcquireTimeouts++;
        reject(
          new SybaseTimeoutError(
            `Connection acquire timeout after ${this.cfg.acquireTimeoutMs}ms`,
            "acquire",
            this.cfg.acquireTimeoutMs
          )
        );
      }, this.cfg.acquireTimeoutMs);

      this.waitQueue.push({ resolve, reject, timer });
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
    conn._inUse = false;
    pooled.lastUsed = Date.now();
    this._activeCount--;

    // Note: SET ROWCOUNT is already reset to 0 within query batches by
    // SybaseSelectBuilder (appends "SET ROWCOUNT 0" after every paginated query).
    // We do NOT issue an async reset here to avoid race conditions where the
    // reset command would execute concurrently with the next user's query.

    // If connection died during use, remove it
    if (!conn.isConnected) {
      const idx = this.pool.indexOf(pooled);
      if (idx !== -1) {
        this.pool.splice(idx, 1);
        conn.close();
        this._totalConnectionsDestroyed++;
      }
      // Try to serve a waiter with a new connection (only if not draining)
      if (!this.draining) {
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
      clearTimeout(waiter.timer);
      pooled.inUse = true;
      conn._inUse = true;
      pooled.lastUsed = Date.now();
      this._activeCount++;
      waiter.resolve(conn);
    }
  }

  /**
   * Execute a query using a pooled connection (auto acquire/release).
   * Retries on transient connection failures.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    options?: { maxRows?: number }
  ): Promise<QueryResult<T>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      const conn = await this.acquire();
      const startTime = Date.now();
      try {
        const result = await conn.query<T>(sql, options);
        const durationMs = Date.now() - startTime;
        this._totalQueriesExecuted++;
        this._queryDurationSum += durationMs;
        this._queryDurationCount++;

        // Log successful query
        if (this.cfg.logger) {
          this.cfg.logger.query({
            sql,
            durationMs,
            rowCount: result.rowCount,
            timestamp: new Date(startTime)
          });
        }

        this.release(conn);
        return result;
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        this._totalQueryErrors++;

        // Log failed query
        if (this.cfg.logger) {
          this.cfg.logger.query({
            sql,
            durationMs,
            rowCount: 0,
            error: err instanceof Error ? err : new Error(String(err)),
            timestamp: new Date(startTime)
          });
        }

        // Reset session state (SET ROWCOUNT) if connection is still alive
        // to prevent state leaking to the next query on this pooled connection.
        if (conn.isConnected) {
          try {
            await conn.query("SET ROWCOUNT 0");
          } catch {
            // If reset fails, connection will be detected dead on release
          }
        }

        this.release(conn);

        if (err instanceof SybaseConnectionError && attempt < this.cfg.retries) {
          // Transient failure — retry after delay
          lastError = err;
          await this.delay(this.cfg.retryDelayMs);
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new SybaseError("Query failed after retries");
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
    this.draining = true;

    // Reject all waiters immediately
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new SybasePoolError("Pool is draining", "draining"));
    }
    this.waitQueue = [];

    // If no active connections, close immediately
    if (this.active === 0) {
      return this.close();
    }

    // Wait for all active connections to be released
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Force close after timeout
        this.close().then(resolve, reject);
      }, timeoutMs);

      if (typeof timer.unref === "function") {
        timer.unref();
      }

      this._drainResolve = () => {
        clearTimeout(timer);
        this.close().then(resolve, reject);
      };
    });
  }

  private _drainResolve?: () => void;

  private checkDrainComplete(): void {
    if (this.draining && this.active === 0 && this._drainResolve) {
      this._drainResolve();
      this._drainResolve = undefined;
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
      clearTimeout(waiter.timer);
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

  private async serveWaiter(): Promise<void> {
    if (this.waitQueue.length === 0) {
      return;
    }

    this._pendingCreates++;
    try {
      const conn = await this.createConnection();
      this._pendingCreates--;
      const pooled: PooledConnection = {
        conn,
        lastUsed: Date.now(),
        createdAt: Date.now(),
        inUse: true
      };
      conn._inUse = true;
      this._activeCount++;
      this.pool.push(pooled);

      // Re-check queue after async operation — waiter may have timed out
      const waiter = this.waitQueue.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(conn);
      } else {
        // No waiter left — release the connection back to idle
        pooled.inUse = false;
        conn._inUse = false;
        this._activeCount--;
      }
    } catch (err: any) {
      this._pendingCreates--;
      // Can't create connection — reject the first waiter if any
      const waiter = this.waitQueue.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(err instanceof Error ? err : new SybaseError(String(err)));
      }
    }
  }

  /**
   * Remove idle connections exceeding min pool size.
   */
  private cleanupIdle(): void {
    const now = Date.now();
    let i = 0;

    while (i < this.pool.length) {
      const pooled = this.pool[i];
      const isIdle = !pooled.inUse;
      const isExpired = now - pooled.lastUsed > this.cfg.idleTimeoutMs;
      const aboveMin = this.pool.length > this.cfg.min;

      if (isIdle && isExpired && aboveMin) {
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
