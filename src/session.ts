/**
 * Sybase session — wraps connection pool to provide query execution.
 *
 * Transactions hold a single connection for the entire duration,
 * with proper BEGIN/COMMIT/ROLLBACK semantics.
 * Supports transaction isolation levels.
 */
import type { SybaseConnection, SybasePool, QueryResult, SybaseLogger } from "./connection.js";
import { SybaseConnectionError } from "./errors.js";

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

export class SybaseSession {
  constructor(private readonly pool: SybasePool) {}

  /**
   * Execute raw SQL and return results.
   */
  async execute<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: { maxRows?: number }
  ): Promise<SybaseSessionQueryResult<T>> {
    const result = await this.pool.query<T>(rawSql, options);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      affectedRows: result.affectedRows
    };
  }

  /**
   * Execute raw SQL and return the full result (including columns).
   */
  async executeRaw(rawSql: string, options?: { maxRows?: number }): Promise<QueryResult> {
    return this.pool.query(rawSql, options);
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
    const isolationChanged = !!options?.isolationLevel;
    try {
      // Set isolation level if specified (applies to the next transaction)
      if (options?.isolationLevel) {
        const level = isolationLevelMap[options.isolationLevel];
        await conn.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
      }

      await conn.query("BEGIN TRAN");
      const tx = new SybaseTransactionSession(conn, this.pool.logger);
      try {
        const result = await fn(tx);
        await conn.query("COMMIT TRAN");
        return result;
      } catch (err) {
        // Attempt rollback — ignore errors if connection is dead
        try {
          await conn.query("ROLLBACK TRAN");
        } catch (_rollbackErr) {
          // If rollback fails, connection is likely dead
          // The pool will detect and discard it on release
        }
        throw err;
      }
    } finally {
      // Reset isolation level to default (read_committed = 1) to prevent leaking
      // session state to subsequent pool users.
      if (isolationChanged && conn.isConnected) {
        try {
          await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevelMap.read_committed}`);
        } catch {
          // Ignore — connection may be dead, pool will discard it
        }
      }
      this.pool.release(conn);
    }
  }
}

// ---------------------------------------------------------------------------
// Transaction session — executes on a single held connection
// ---------------------------------------------------------------------------

export class SybaseTransactionSession {
  constructor(
    private readonly conn: SybaseConnection,
    private readonly logger?: SybaseLogger
  ) {}

  /**
   * Execute raw SQL within the transaction.
   */
  async execute<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: { maxRows?: number }
  ): Promise<SybaseSessionQueryResult<T>> {
    const result = await this.runWithLogging<T>(rawSql, options);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      affectedRows: result.affectedRows
    };
  }

  async executeRaw(rawSql: string, options?: { maxRows?: number }): Promise<QueryResult> {
    return this.runWithLogging(rawSql, options);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async runWithLogging<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: { maxRows?: number }
  ): Promise<QueryResult<T>> {
    if (!this.conn.isConnected) {
      throw new SybaseConnectionError("Transaction connection is dead");
    }
    const startTime = Date.now();
    try {
      const result = await this.conn.query<T>(rawSql, options);
      if (this.logger) {
        this.logger.query({
          sql: rawSql,
          durationMs: Date.now() - startTime,
          rowCount: result.rowCount,
          timestamp: new Date(startTime)
        });
      }
      return result;
    } catch (err) {
      if (this.logger) {
        this.logger.query({
          sql: rawSql,
          durationMs: Date.now() - startTime,
          rowCount: 0,
          error: err instanceof Error ? err : new Error(String(err)),
          timestamp: new Date(startTime)
        });
      }
      throw err;
    }
  }
}
