/**
 * Sybase table definition — wraps mssqlTable from drizzle-orm/mssql-core.
 *
 * Since Sybase ASE and MSSQL share the same table infrastructure in Drizzle,
 * we re-export `mssqlTable` as `sybaseTable` for semantic clarity.
 */
import { mssqlTable } from "drizzle-orm/mssql-core";

export { MsSqlTable as SybaseTable } from "drizzle-orm/mssql-core";

/**
 * Define a Sybase table schema.
 *
 * @example
 * ```ts
 * const users = sybaseTable("users", {
 *   id: int("id").primaryKey().identity(),
 *   name: varchar("name", { length: 100 }).notNull(),
 *   email: varchar("email", { length: 200 })
 * });
 * ```
 */
export const sybaseTable = mssqlTable;
