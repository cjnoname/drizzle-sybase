/**
 * drizzle-sybase — Drizzle ORM driver for Sybase ASE.
 *
 * Self-contained package with FreeTDS native bindings. No system
 * dependencies, no Lambda layers, no child_process hacks.
 *
 * Features:
 * - Native FreeTDS db-lib connection (persistent TCP, not per-query fork)
 * - Connection pooling with metrics and graceful shutdown
 * - Real database transactions (BEGIN TRAN / COMMIT / ROLLBACK) with isolation levels
 * - Type-aware result mapping (int → number, bit → boolean, etc.)
 * - Drizzle-compatible query builders (select/insert/update/delete)
 * - Full Sybase ASE SQL dialect support
 * - Query logging/middleware support
 * - Fine-grained error hierarchy
 *
 * @example
 * ```ts
 * import {
 *   sybaseTable, int, varchar, datetime,
 *   createSybaseDrizzle
 * } from "drizzle-sybase";
 * import { eq } from "drizzle-orm";
 *
 * const users = sybaseTable("users", {
 *   id: int("id").primaryKey().identity(),
 *   name: varchar("name", { length: 100 }).notNull(),
 *   email: varchar("email", { length: 200 }),
 *   createdAt: datetime("created_at")
 * });
 *
 * const db = createSybaseDrizzle({
 *   host: "sybase-host",
 *   port: 5000,
 *   database: "mydb",
 *   username: "sa",
 *   password: "secret",
 *   max: 10,   // pool size
 *   logger: { query(log) { console.log(`[${log.durationMs}ms] ${log.sql}`); } }
 * });
 *
 * // Query
 * const result = await db.select().from(users).where(eq(users.name, "Alice"));
 *
 * // Transaction with isolation level
 * await db.transaction(async tx => {
 *   await tx.insert(users).values({ name: "Bob", email: "bob@example.com" });
 *   await tx.update(users).set({ name: "Robert" }).where(eq(users.name, "Bob"));
 * }, { isolationLevel: "serializable" });
 *
 * // Pool metrics
 * console.log(db.pool.metrics);
 *
 * // Graceful shutdown
 * await db.drain();
 * ```
 */

// Table
export { sybaseTable } from "./table.js";
export { SybaseTable } from "./table.js";

// Column types
export {
  int,
  bigint,
  smallint,
  tinyint,
  varchar,
  nvarchar,
  char,
  nchar,
  text,
  ntext,
  datetime,
  smalldatetime,
  numeric,
  decimal,
  float,
  real,
  money,
  smallmoney,
  bit,
  binary,
  varbinary,
  image
} from "./columns/index.js";

// Database instance
export { createSybaseDrizzle } from "./db.js";
export type { SybaseDrizzle, SybaseDrizzleTx, SybaseDrizzleConfig } from "./db.js";

// Errors
export {
  SybaseError,
  SybaseConnectionError,
  SybaseQueryError,
  SybaseTimeoutError,
  SybasePoolError
} from "./errors.js";

// Connection + Pool
export { SybaseConnection, SybasePool } from "./connection.js";
export type {
  SybaseConnectionConfig,
  SybasePoolConfig,
  SybasePoolMetrics,
  SybaseLogger,
  SybaseQueryLog,
  QueryResult
} from "./connection.js";

// Dialect
export { SybaseDialect, escapeName, escapeString, serializeValue } from "./dialect.js";
export type { SybaseDialectConfig } from "./dialect.js";

// Codecs (CONVERT wrapping for exact numeric types)
export { SYBASE_CODECS, EXACT_NUMERIC_TYPES } from "./codecs.js";

// Datetime conversion (ASE stores a naive wall clock)
export {
  formatSybaseDateTime,
  parseSybaseDateTime,
  decodeDateTimeColumns,
  resolveTimeZone
} from "./datetime.js";

// Session
export { SybaseSession, SybaseTransactionSession } from "./session.js";
export type {
  SybaseTransactionOptions,
  SybaseIsolationLevel,
  SybaseSessionQueryResult
} from "./session.js";

// Query builders
export {
  SybaseSelectBuilder,
  SybaseInsertBuilder,
  SybaseUpdateBuilder,
  SybaseDeleteBuilder
} from "./query-builders/index.js";
export type {
  SybaseSelectConfig,
  SybaseSelectField,
  SybaseSelectJoin,
  SybaseSelectWithCTE,
  SybaseInsertResult,
  SybaseUpdateResult,
  SybaseDeleteResult
} from "./query-builders/index.js";

// Re-export SQL type for convenience (type-only)
export type { SQL } from "drizzle-orm";

// Native binding utilities (lazy-loaded — only triggers native load on actual use)
export { native, getNative } from "./native/index.js";
export type { NativeBinding } from "./native/index.js";
