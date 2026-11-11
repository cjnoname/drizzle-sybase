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
import { is, SQL } from "drizzle-orm";

import type { SybaseBulkInsertOptions, SybaseBulkInsertResult } from "./bulk.js";
import type { SybaseFileQueryOptions, SybaseQueryOptions } from "./connection.js";
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
import type { SybaseColumnarResult, SybaseFileResult } from "./result.js";
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

/**
 * What `execute`, `exec` and `executeRaw` resolve to. `resultSets` is there only
 * with the `allResultSets` option: the rows of every result set that has
 * columns, in order, the first being `rows`.
 */
export interface SybaseExecuteResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  resultSets?: Record<string, unknown>[][];
}

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
  /**
   * Execute raw SQL using Drizzle's `sql` template tag. `options.maxRows` lets a
   * result pass the default 1,000,000-row cap (or truncates it below that).
   */
  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL,
    options?: SybaseQueryOptions
  ): Promise<SybaseExecuteResult<T>>;
  /** Execute a stored procedure or raw SQL. */
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL,
    options?: SybaseQueryOptions
  ): Promise<SybaseExecuteResult<T>>;
  /** Execute a raw SQL string directly. */
  executeRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseExecuteResult<T>>;
  /**
   * Execute SQL (a `sql` template or a raw string) and return the result column
   * by column — for bulk reads such as exports to Arrow, DuckDB or Parquet,
   * where building an object per row is most of the cost. Each column's values
   * come as one array (a typed array for fixed-width numbers); see
   * `SybaseColumnValues`.
   *
   * @example
   * ```ts
   * const { columns, rowCount } = await db.executeColumns(
   *   sql`select id, name from users where id > ${lo} and id <= ${hi}`,
   *   { maxRows: 5_000_000 }
   * );
   * ```
   */
  executeColumns(query: SQL | string, options?: SybaseQueryOptions): Promise<SybaseColumnarResult>;
  /**
   * Execute SQL and write the rows to a CSV file as they arrive, without holding
   * them or turning them into JS values — the cheapest way to land a large
   * result, e.g. for DuckDB to convert to Parquet. See `SybaseFileResult` for the
   * format; a failed query leaves no file.
   *
   * @example
   * ```ts
   * const { columns, columnTypes, rowCount } = await db.executeToFile(
   *   sql`select id, name from users where id > ${lo} and id <= ${hi}`,
   *   { path: "/tmp/users-0001.csv" }
   * );
   * ```
   */
  executeToFile(query: SQL | string, options: SybaseFileQueryOptions): Promise<SybaseFileResult>;
  /**
   * Bulk copy rows into a table — db-lib's bcp, in process, on a pooled
   * connection, outside any transaction. Committed in batches (`batchSize`,
   * default: one batch for the whole call); the result's counts are what the
   * server reported. A failure throws `SybaseBulkCopyError`, which says
   * exactly what earlier batches committed. See the README's "Bulk Copy".
   *
   * @example
   * ```ts
   * const { rowsCopied } = await db.bulkInsert({
   *   table: "apradb..DDSD",
   *   columns: ["RCSBkey", "cd_unit_type", "line_number", "amount"],
   *   rows: chunk, // arrays of values, or TSV
   *   batchSize: 20_000,
   *   expectedRows: chunk.length
   * });
   * ```
   */
  bulkInsert(options: SybaseBulkInsertOptions): Promise<SybaseBulkInsertResult>;
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
  withConnection<T>(fn: (conn: SybaseDrizzleConnection) => Promise<T>): Promise<T>;
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
    query: SQL,
    options?: SybaseQueryOptions
  ): Promise<SybaseExecuteResult<T>>;
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL,
    options?: SybaseQueryOptions
  ): Promise<SybaseExecuteResult<T>>;
  executeRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string,
    options?: SybaseQueryOptions
  ): Promise<SybaseExecuteResult<T>>;
  /** See {@link SybaseDrizzle.executeColumns}. */
  executeColumns(query: SQL | string, options?: SybaseQueryOptions): Promise<SybaseColumnarResult>;
  /** See {@link SybaseDrizzle.executeToFile}. */
  executeToFile(query: SQL | string, options: SybaseFileQueryOptions): Promise<SybaseFileResult>;
}

/**
 * The handle `withConnection` gives its callback: one held connection, no
 * transaction — the transaction handle's queries, plus bulk copy (which a
 * transaction cannot run).
 */
export interface SybaseDrizzleConnection extends SybaseDrizzleTx {
  /**
   * Bulk copy rows into a table on this connection — e.g. into a `#temp`
   * table created earlier in the callback. See {@link SybaseDrizzle.bulkInsert}.
   * A copy that fails part way closes the connection.
   */
  bulkInsert(options: SybaseBulkInsertOptions): Promise<SybaseBulkInsertResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * The decoder a `sql` field (or an aliased one) was given with `.mapWith()`, as
 * Drizzle's own row mapping applies it; none for plain SQL or a column.
 */
const sqlDecoder = (field: unknown): ((value: unknown) => unknown) | undefined => {
  const source = is(field, SQL) ? field : is(field, SQL.Aliased) ? field.sql : undefined;
  // Not in drizzle-orm's declarations, but where mapWith() keeps it (sql.js) and
  // where its own row mappers read it from (utils.js, makeDefaultQueryMapper).
  const decoder = (source as { decoder?: { mapFromDriverValue: (value: unknown) => unknown } })
    ?.decoder;
  if (!decoder || (decoder.mapFromDriverValue as { isNoop?: boolean }).isNoop) {
    return undefined;
  }
  return value => decoder.mapFromDriverValue(value);
};

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
      // It names the column in the result: SQL has no empty name to give it.
      if (alias === "") {
        throw new Error("Cannot select a field under an empty name");
      }
      const expression = dialect.renderExpression(field, "field");
      if (expression === undefined) {
        throw new Error(
          `Cannot resolve field "${alias}": unsupported value type. ` +
            `Expected a column reference, SQL expression, or string.`
        );
      }
      return { expression, alias, decode: sqlDecoder(field) };
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

    async execute<T extends Record<string, unknown>>(query: SQL, options?: SybaseQueryOptions) {
      return on.execute<T>(dialect.sqlToQuery(query), options);
    },

    async exec<T extends Record<string, unknown>>(query: SQL, options?: SybaseQueryOptions) {
      return on.execute<T>(dialect.sqlToQuery(query), options);
    },

    async executeRaw<T extends Record<string, unknown>>(
      rawSql: string,
      options?: SybaseQueryOptions
    ) {
      return on.execute<T>(rawSql, options);
    },

    async executeColumns(query: SQL | string, options?: SybaseQueryOptions) {
      return on.executeColumns(
        typeof query === "string" ? query : dialect.sqlToQuery(query),
        options
      );
    },

    async executeToFile(query: SQL | string, options: SybaseFileQueryOptions) {
      return on.executeToFile(
        typeof query === "string" ? query : dialect.sqlToQuery(query),
        options
      );
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

    async bulkInsert(options: SybaseBulkInsertOptions) {
      return session.bulkInsert(options);
    },

    async withConnection<T>(fn: (conn: SybaseDrizzleConnection) => Promise<T>): Promise<T> {
      return session.withConnection(connSession =>
        fn({
          ...queryApi(connSession),
          bulkInsert: options => connSession.bulkInsert(options)
        })
      );
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
