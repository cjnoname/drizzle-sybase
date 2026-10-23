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

import { SybaseDialect } from "./dialect.js";
import type { SybaseDialectConfig } from "./dialect.js";
import type { SybasePoolConfig, SybasePoolMetrics } from "./pool.js";
import { SybasePool } from "./pool.js";
import {
  SybaseSelectBuilder,
  SybaseInsertBuilder,
  SybaseUpdateBuilder,
  SybaseDeleteBuilder
} from "./query-builders/index.js";
import type { SybaseSelectField } from "./query-builders/index.js";
import type { InitialSelectState, SybaseSelectFields } from "./query-builders/select-types.js";
import { SybaseSession } from "./session.js";
import type {
  SybaseConnectionSession,
  SybaseTransactionOptions,
  SybaseTransactionSession
} from "./session.js";
import type { AnySybaseTable } from "./table.js";

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
  /**
   * Start a SELECT query.
   *
   * With no fields, every column of the source tables is selected, keyed by
   * property name, and the row type is inferred from the table definitions.
   * With fields, each key holds that field's value.
   */
  select(): SybaseSelectBuilder<InitialSelectState<undefined>>;
  select<TFields extends SybaseSelectFields>(
    fields: TFields
  ): SybaseSelectBuilder<InitialSelectState<TFields>>;
  /** Start an INSERT query. */
  insert<TTable extends AnySybaseTable>(table: TTable): SybaseInsertBuilder<TTable>;
  /** Start an UPDATE query. */
  update<TTable extends AnySybaseTable>(table: TTable): SybaseUpdateBuilder<TTable>;
  /** Start a DELETE query. */
  delete<TTable extends AnySybaseTable>(table: TTable): SybaseDeleteBuilder<TTable>;
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
  /**
   * Run statements on one connection, outside a transaction — for work that
   * spans several statements on the same session, such as `#temp` tables
   * (which a plain query drops when it finishes). Statements autocommit.
   * Afterwards `#temp` tables are dropped and the session is reset; a
   * transaction left open is rolled back and reported as an error.
   *
   * @example
   * ```ts
   * await db.withConnection(async conn => {
   *   await conn.executeRaw("select id into #ids from orders where ...");
   *   return conn.select().from(sybaseTable("#ids", { id: int("id") }));
   * });
   * ```
   */
  withConnection<T>(fn: (conn: SybaseDrizzleTx) => Promise<T>): Promise<T>;
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
  select(): SybaseSelectBuilder<InitialSelectState<undefined>>;
  select<TFields extends SybaseSelectFields>(
    fields: TFields
  ): SybaseSelectBuilder<InitialSelectState<TFields>>;
  insert<TTable extends AnySybaseTable>(table: TTable): SybaseInsertBuilder<TTable>;
  update<TTable extends AnySybaseTable>(table: TTable): SybaseUpdateBuilder<TTable>;
  delete<TTable extends AnySybaseTable>(table: TTable): SybaseDeleteBuilder<TTable>;
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

  /** `undefined` (no fields) lets the builder select every column by property name. */
  const resolveFields = (fields?: SybaseSelectFields): SybaseSelectField[] | undefined => {
    if (!fields) {
      return undefined;
    }
    return Object.entries(fields).map(([alias, field]) => {
      const expression = dialect.renderExpression(field, "field");
      if (expression === undefined) {
        throw new Error(
          `Cannot resolve field "${alias}": unsupported value type. ` +
            `Expected a column reference, SQL expression, or string.`
        );
      }
      return { expression, alias };
    });
  };

  /**
   * The query surface shared by the top-level handle and a transaction handle.
   *
   * Both expose exactly these members and differ only in which session they run
   * on, so they are built from one definition — keeping them as two literals made
   * it possible to change one and forget the other.
   */
  const queryApi = (
    on: SybaseSession | SybaseTransactionSession | SybaseConnectionSession
  ): SybaseDrizzleTx => ({
    // One implementation behind the two `select` overloads: the fields only
    // shape the result type, which the overloads describe.
    select: ((fields?: SybaseSelectFields) =>
      new SybaseSelectBuilder(dialect, on, resolveFields(fields))) as SybaseDrizzleTx["select"],

    insert<TTable extends AnySybaseTable>(table: TTable) {
      return new SybaseInsertBuilder(table, dialect, on);
    },

    update<TTable extends AnySybaseTable>(table: TTable) {
      return new SybaseUpdateBuilder(table, dialect, on);
    },

    delete<TTable extends AnySybaseTable>(table: TTable) {
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

    async withConnection<T>(fn: (conn: SybaseDrizzleTx) => Promise<T>): Promise<T> {
      return session.withConnection(connSession => fn(queryApi(connSession)));
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
