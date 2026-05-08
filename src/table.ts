/**
 * Sybase table definition.
 *
 * Creates table objects that pass drizzle-orm's `is(table, Table)` check
 * via the entityKind symbol mechanism. Column objects on the table also
 * pass `is(col, Column)` for use with eq(), sql template, etc.
 *
 * Does NOT depend on drizzle-orm/mssql-core.
 */

import { SybaseColumnBuilder, type SybaseColumn } from "./columns/index.js";

const entityKind = Symbol.for("drizzle:entityKind");

// Symbols used by drizzle-orm's Table and sql.js
const TableName = Symbol.for("drizzle:Name");
const TableSchema = Symbol.for("drizzle:Schema");
const OriginalName = Symbol.for("drizzle:OriginalName");
const TableColumns = Symbol.for("drizzle:Columns");
const BaseName = Symbol.for("drizzle:BaseName");
const IsAlias = Symbol.for("drizzle:IsAlias");
const IsDrizzleTable = Symbol.for("drizzle:IsDrizzleTable");
const ExtraConfigBuilder = Symbol.for("drizzle:ExtraConfigBuilder");
const ExtraConfigColumns = Symbol.for("drizzle:ExtraConfigColumns");

// ---------------------------------------------------------------------------
// SybaseTable class
// ---------------------------------------------------------------------------

export class SybaseTable {
  static [entityKind] = "SybaseTable";

  // Static Symbol map matching Table.Symbol structure
  static Symbol = {
    Name: TableName,
    Schema: TableSchema,
    OriginalName,
    Columns: TableColumns,
    BaseName,
    IsAlias,
    ExtraConfigBuilder,
    ExtraConfigColumns
  };

  constructor(name: string, schema?: string) {
    (this as any)[TableName] = name;
    (this as any)[OriginalName] = name;
    (this as any)[TableSchema] = schema;
    (this as any)[BaseName] = name;
    (this as any)[IsAlias] = false;
    (this as any)[IsDrizzleTable] = true;
    (this as any)[ExtraConfigBuilder] = undefined;
    (this as any)[ExtraConfigColumns] = undefined;
  }
}

// Make SybaseTable pass `is(table, Table)` by inserting a marker
// with entityKind = "Table" in the prototype chain.
function _createTableMarker() {
  function DrizzleTableMarker() {}
  Object.defineProperty(DrizzleTableMarker, entityKind, { value: "Table" });
  return DrizzleTableMarker;
}
const _TableMarker = _createTableMarker();
Object.setPrototypeOf(SybaseTable.prototype, _TableMarker.prototype);
Object.setPrototypeOf(SybaseTable, _TableMarker);

// ---------------------------------------------------------------------------
// sybaseTable factory
// ---------------------------------------------------------------------------

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
export const sybaseTable = (name: string, columns: Record<string, SybaseColumnBuilder>): any => {
  const table = new SybaseTable(name);
  const builtColumns: Record<string, SybaseColumn> = {};

  for (const [key, builder] of Object.entries(columns)) {
    if (builder instanceof SybaseColumnBuilder) {
      const col = builder.build(table);
      builtColumns[key] = col;
      // Expose column directly on table for use in eq(table.col, value)
      (table as any)[key] = col;
    }
  }

  // Set the Columns symbol so getTableColumns() works
  (table as any)[TableColumns] = builtColumns;

  return table;
};
