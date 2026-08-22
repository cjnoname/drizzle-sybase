/**
 * Sybase Drizzle database instance.
 *
 * Provides a Drizzle-like API for Sybase ASE backed by native FreeTDS
 * connections with connection pooling.
 *
 * @example
 * ```ts
 * import { createSybaseDrizzle, sybaseTable, int, varchar } from "drizzle-sybase";
 * import { eq } from "drizzle-orm";
 *
 * const users = sybaseTable("users", {
 *   id: int("id").primaryKey().identity(),
 *   name: varchar("name", { length: 100 }).notNull()
 * });
 *
 * const db = createSybaseDrizzle({
 *   host: "sybase-host",
 *   port: 5000,
 *   database: "mydb",
 *   username: "sa",
 *   password: "secret"
 * });
 *
 * const result = await db.select().from(users).where(eq(users.name, "Alice"));
 * await db.close();
 * ```
 */
import type { SQL } from "drizzle-orm";
import { getTableName } from "drizzle-orm";

import type { SybasePoolConfig, SybasePoolMetrics } from "./connection.js";
import { SybasePool } from "./connection.js";
import { SybaseDialect, escapeName } from "./dialect.js";
import type { SybaseDialectConfig } from "./dialect.js";
import {
  SybaseSelectBuilder,
  SybaseInsertBuilder,
  SybaseUpdateBuilder,
  SybaseDeleteBuilder
} from "./query-builders/index.js";
import type { SybaseSelectField } from "./query-builders/index.js";
import { SybaseSession } from "./session.js";
import type { SybaseTransactionOptions, SybaseTransactionSession } from "./session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SybaseDrizzleConfig = SybasePoolConfig & {
  /**
   * Extra or overriding codecs for inlined parameters, merged over the built-in
   * Sybase set (which wraps money/numeric literals in CONVERT).
   */
  codecs?: SybaseDialectConfig["codecs"];
};

export interface SybaseDrizzle {
  /** Start a SELECT query. */
  select(fields?: Record<string, any>): SybaseSelectBuilder;
  /** Start an INSERT query. */
  insert(table: any): SybaseInsertBuilder;
  /** Start an UPDATE query. */
  update(table: any): SybaseUpdateBuilder;
  /** Start a DELETE query. */
  delete(table: any): SybaseDeleteBuilder;
  /** Execute raw SQL using Drizzle's `sql` template tag. */
  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** Execute a stored procedure or raw SQL. */
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** Execute a raw SQL string directly. */
  executeRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string
  ): Promise<{ rows: T[]; rowCount: number }>;
  /**
   * Run statements in a real database transaction.
   *
   * @example
   * ```ts
   * await db.transaction(async tx => {
   *   await tx.insert(users).values({ name: "Alice" });
   * }, { isolationLevel: "serializable" });
   * ```
   */
  transaction<T>(
    fn: (tx: SybaseDrizzleTx) => Promise<T>,
    options?: SybaseTransactionOptions
  ): Promise<T>;
  /** Close all connections and shut down the pool. */
  close(): Promise<void>;
  /**
   * Gracefully drain the pool — finish all in-flight operations, then close.
   * New operations will be rejected immediately.
   *
   * @param timeoutMs - Maximum time to wait for drain. Default: 30000ms
   */
  drain(timeoutMs?: number): Promise<void>;
  /** Connection pool stats. */
  readonly pool: {
    /** Total connections in pool. */
    readonly size: number;
    /** Active (in-use) connections. */
    readonly active: number;
    /** Idle (available) connections. */
    readonly idle: number;
    /** Requests waiting for a connection. */
    readonly waiting: number;
    /** Whether the pool is draining. */
    readonly isDraining: boolean;
    /** Whether the pool is closed. */
    readonly isClosed: boolean;
    /** Pool metrics snapshot for monitoring. */
    readonly metrics: SybasePoolMetrics;
  };
}

/**
 * Transaction handle — executes on a single held connection.
 */
export interface SybaseDrizzleTx {
  select(fields?: Record<string, any>): SybaseSelectBuilder;
  insert(table: any): SybaseInsertBuilder;
  update(table: any): SybaseUpdateBuilder;
  delete(table: any): SybaseDeleteBuilder;
  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL
  ): Promise<{ rows: T[]; rowCount: number }>;
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL
  ): Promise<{ rows: T[]; rowCount: number }>;
  executeRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string
  ): Promise<{ rows: T[]; rowCount: number }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const createSybaseDrizzle = (config: SybaseDrizzleConfig): SybaseDrizzle => {
  const dialect = new SybaseDialect({ codecs: config.codecs, timeZone: config.timeZone });
  const pool = new SybasePool(config);
  const session = new SybaseSession(pool, config.timeZone);

  const resolveFields = (fields?: Record<string, any>): SybaseSelectField[] => {
    if (!fields) {
      return [{ expression: "*" }];
    }
    return Object.entries(fields).map(([alias, field]) => {
      if (field && field.name && field.table) {
        const tableName = getTableName(field.table);
        return {
          expression: `${escapeName(tableName)}.${escapeName(field.name)}`,
          alias
        };
      }
      if (field && typeof field.getSQL === "function") {
        const sqlStr = dialect.sqlToQuery(field.getSQL());
        return { expression: sqlStr, alias };
      }
      if (field && typeof field.toQuery === "function") {
        return { expression: dialect.sqlToQuery(field), alias };
      }
      if (typeof field === "string") {
        return { expression: field, alias };
      }
      throw new Error(
        `Cannot resolve field "${alias}": unsupported value type. ` +
          `Expected a column reference, SQL expression, or string.`
      );
    });
  };

  /**
   * The query surface shared by the top-level handle and a transaction handle.
   *
   * Both expose exactly these members and differ only in which session they run
   * on, so they are built from one definition — keeping them as two literals made
   * it possible to change one and forget the other.
   */
  const queryApi = (on: SybaseSession | SybaseTransactionSession): SybaseDrizzleTx => ({
    select(fields?: Record<string, any>) {
      return new SybaseSelectBuilder(dialect, on, resolveFields(fields));
    },

    insert(table: any) {
      return new SybaseInsertBuilder(table, dialect, on);
    },

    update(table: any) {
      return new SybaseUpdateBuilder(table, dialect, on);
    },

    delete(table: any) {
      return new SybaseDeleteBuilder(table, dialect, on);
    },

    async execute<T extends Record<string, unknown>>(query: SQL) {
      return on.execute<T>(dialect.sqlToQuery(query));
    },

    async exec<T extends Record<string, unknown>>(query: SQL) {
      return on.execute<T>(dialect.sqlToQuery(query));
    },

    async executeRaw<T extends Record<string, unknown>>(rawSql: string) {
      return on.execute<T>(rawSql);
    }
  });

  return {
    ...queryApi(session),

    async transaction<T>(
      fn: (tx: SybaseDrizzleTx) => Promise<T>,
      options?: SybaseTransactionOptions
    ): Promise<T> {
      return session.transaction(txSession => fn(queryApi(txSession)), options);
    },

    async close() {
      await pool.close();
    },

    async drain(timeoutMs?: number) {
      await pool.drain(timeoutMs);
    },

    get pool() {
      return {
        get size() {
          return pool.size;
        },
        get active() {
          return pool.active;
        },
        get idle() {
          return pool.idle;
        },
        get waiting() {
          return pool.waiting;
        },
        get isDraining() {
          return pool.isDraining;
        },
        get isClosed() {
          return pool.isClosed;
        },
        get metrics() {
          return pool.metrics;
        }
      };
    }
  };
};
