/**
 * Sybase table definition.
 *
 * Creates table objects that pass drizzle-orm's `is(table, Table)` check
 * via the entityKind symbol mechanism. Column objects on the table also
 * pass `is(col, Column)` for use with eq(), sql template, etc.
 *
 * Does NOT depend on drizzle-orm/mssql-core.
 */

import type { Column, SQLWrapper } from "drizzle-orm";

import {
  SybaseColumnBuilder,
  type SybaseColumn,
  type SybaseColumnRead,
  type SybaseColumnWrite
} from "./columns/index.js";

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
// Types
// ---------------------------------------------------------------------------

type AnyColumnBuilder = SybaseColumnBuilder<any>;

/** Flatten an intersection into one object type, for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * How the select builder tells tables apart in types: `owner.name` when an
 * owner was given, the bare name otherwise — the same distinction the SQL
 * makes (`[owner].[name]` vs `[name]`).
 */
export type SybaseTableKey<
  TName extends string,
  TOwner extends string | undefined
> = TOwner extends string ? `${TOwner}.${TName}` : TName;

/** Built columns of a table, keyed by property name. */
export type SybaseTableColumns<
  TKey extends string,
  TColumns extends Record<string, AnyColumnBuilder>
> = {
  [K in keyof TColumns]: SybaseColumn<TColumns[K]["_"], TKey>;
};

/** Row a select returns: `null` for every nullable column. */
type SelectModel<TColumns extends Record<string, AnyColumnBuilder>> = Simplify<{
  [K in keyof TColumns]: SybaseColumnRead<TColumns[K]>;
}>;

/** Columns an insert must supply: not null, and nothing else would fill them. */
type RequiredInsertKey<C extends AnyColumnBuilder> = C["_"]["notNull"] extends true
  ? C["_"]["hasDefault"] extends true
    ? false
    : true
  : false;

/**
 * Values an insert accepts. Identity columns are absent — the server assigns
 * them and the insert builder never writes them. A column may be omitted when
 * it is nullable or something supplies a default.
 */
type InsertModel<TColumns extends Record<string, AnyColumnBuilder>> = Simplify<
  {
    [
      K in keyof TColumns as TColumns[K]["_"]["identity"] extends true
        ? never
        : RequiredInsertKey<TColumns[K]> extends true
          ? K
          : never
    ]: SybaseColumnWrite<TColumns[K]>;
  } & {
    [
      K in keyof TColumns as TColumns[K]["_"]["identity"] extends true
        ? never
        : RequiredInsertKey<TColumns[K]> extends true
          ? never
          : K
    ]?: SybaseColumnWrite<TColumns[K]>;
  }
>;

/** A table defined with {@link sybaseTable}, with its columns as properties. */
export type SybaseTableWithColumns<
  TName extends string,
  TColumns extends Record<string, AnyColumnBuilder>,
  TOwner extends string | undefined = undefined
> = SybaseTable<TName, TOwner> &
  SybaseTableColumns<SybaseTableKey<TName, TOwner>, TColumns> & {
    /** Row type a select returns (type only). */
    readonly $inferSelect: SelectModel<TColumns>;
    /** Values an insert accepts (type only). */
    readonly $inferInsert: InsertModel<TColumns>;
  };

/** Any table defined with {@link sybaseTable}. */
export type AnySybaseTable = SybaseTable<string> & {
  readonly $inferSelect: Record<string, unknown>;
  readonly $inferInsert: Record<string, unknown>;
};

/** Row type a select on `T` returns. */
export type InferSelectModel<T extends AnySybaseTable> = T["$inferSelect"];

/** Values an insert into `T` accepts. */
export type InferInsertModel<T extends AnySybaseTable> = T["$inferInsert"];

/** One row for `insert(T).values(...)`: each value may also be a SQL expression. */
export type SybaseInsertValues<T extends AnySybaseTable> = {
  [K in keyof T["$inferInsert"]]: T["$inferInsert"][K] | SQLWrapper;
};

/**
 * Values for `update(T).set(...)`: any subset of the writable columns, each
 * value possibly a SQL expression. Identity columns cannot be updated.
 */
export type SybaseUpdateValues<T extends AnySybaseTable> = {
  [K in keyof T["$inferInsert"]]?: Exclude<T["$inferInsert"][K], undefined> | SQLWrapper;
};

// ---------------------------------------------------------------------------
// SybaseTable class
// ---------------------------------------------------------------------------

export class SybaseTable<
  TName extends string = string,
  TOwner extends string | undefined = string | undefined
> {
  static [entityKind] = "SybaseTable";

  /**
   * Type-level description (phantom: absent at runtime), shaped like
   * drizzle's `TableTypeConfig` so a Sybase table is a drizzle `Table` to the
   * type checker too — as it already is at runtime (`is(table, Table)`). That
   * is what lets drizzle's own helpers (`getTableName`, `getColumns`, ...) take
   * one. `columns` is drizzle's general column type, which is how drizzle
   * treats these columns; the precise types live on the table's properties.
   */
  declare readonly _: {
    readonly brand: "Table";
    readonly name: TName;
    readonly schema: TOwner;
    readonly columns: Record<string, Column>;
    readonly dialect: "sybase";
  };

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
 * `owner` qualifies the table as `[owner].[name]` everywhere it is referenced.
 * Leave it unset for tables that should resolve the usual way (the current
 * user's object, then dbo's).
 *
 * @example
 * ```ts
 * const users = sybaseTable("users", {
 *   id: int("id").primaryKey().identity(),
 *   name: varchar("name", { length: 100 }).notNull(),
 *   email: varchar("email", { length: 200 })
 * });
 *
 * const audit = sybaseTable("audit", { id: int("id") }, { owner: "ops" });
 * ```
 */
export const sybaseTable = <
  const TName extends string,
  TColumns extends Record<string, AnyColumnBuilder>,
  const TOwner extends string | undefined = undefined
>(
  name: TName,
  columns: TColumns,
  options?: { owner?: TOwner }
): SybaseTableWithColumns<TName, TColumns, TOwner> => {
  const table = new SybaseTable(name, options?.owner);
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

  return table as SybaseTableWithColumns<TName, TColumns, TOwner>;
};
