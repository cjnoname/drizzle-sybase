/**
 * Sybase column type builders.
 *
 * Creates column objects that pass drizzle-orm's `is(col, Column)` check
 * by using the same entityKind symbol mechanism. This ensures compatibility
 * with drizzle-orm operators (eq, ne, gt, sql template, etc.).
 *
 * Does NOT depend on drizzle-orm/mssql-core.
 */

import { aliasedColumn } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { EXACT_NUMERIC_TYPES } from "../codecs.js";

/** drizzle's handle from an aliased column back to the column it aliases. */
export const OriginalColumn: unique symbol = Symbol.for("drizzle:OriginalColumn");

// ---------------------------------------------------------------------------
// Type-level column description
// ---------------------------------------------------------------------------

/**
 * What the type system knows about a column. Carried by builders and built
 * columns as a phantom (`_`), never present at runtime.
 *
 * `data` and `write` differ on purpose: an exact numeric column is *read* as a
 * string (so no digits are lost), but may be *written* from any JS value it can
 * hold exactly.
 */
export interface SybaseColumnTypeConfig {
  /** JS type a select returns for a non-null value (see `binding.c`). */
  data: unknown;
  /** JS types an insert or update accepts for a non-null value. */
  write: unknown;
  notNull: boolean;
  /** Omittable on insert: a default, a `$defaultFn` / `$onUpdateFn`, or one the database supplies. */
  hasDefault: boolean;
  /** Assigned by the server; never written. */
  identity: boolean;
}

/** Initial config for a column factory: nullable, no default, not an identity. */
type ColumnOf<TData, TWrite = TData> = {
  data: TData;
  write: TWrite;
  notNull: false;
  hasDefault: false;
  identity: false;
};

/** `T` with the keys of `U` replaced. */
type With<T extends SybaseColumnTypeConfig, U extends Partial<SybaseColumnTypeConfig>> = {
  [K in keyof SybaseColumnTypeConfig]: K extends keyof U ? U[K] : T[K];
};

/** Precisions whose every value a double holds exactly (`MAX_EXACT_DECIMAL_DIGITS`). */
type ExactPrecision = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/**
 * What a fixed-point column accepts on write, from its declared width — the
 * same decision `decimalRepresentation` makes for the generated Zod schemas:
 * a `number` only where a double holds every value, a `bigint` only for
 * integers too wide for one, and a digit string always.
 */
type DecimalWrite<P, S> = [P] extends [undefined]
  ? string
  : number extends P
    ? string
    : P extends ExactPrecision
      ? number | string
      : P extends 0
        ? string
        : [S] extends [0 | undefined]
          ? bigint | string
          : string;

/** A literal option's type, or `undefined` when the option was not given. */
type OptionOf<O, K extends string> = O extends { [P in K]: infer V } ? V : undefined;

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

/** Anything carrying a column type config: a builder or a built column. */
type HasColumnType = { readonly _: SybaseColumnTypeConfig };

/** The value a select returns for this column. */
export type SybaseColumnRead<C extends HasColumnType> = C["_"]["notNull"] extends true
  ? C["_"]["data"]
  : C["_"]["data"] | null;

/** The value an insert or update may write to this column. */
export type SybaseColumnWrite<C extends HasColumnType> = C["_"]["notNull"] extends true
  ? C["_"]["write"]
  : C["_"]["write"] | null;
// We use the entityKind symbol to make our classes recognized by drizzle-orm's
// `is()` function without needing to extend the heavily-generic base classes.
const entityKind = Symbol.for("drizzle:entityKind");

/** Codec keys, by the base type name a declared SQL type starts with. */
const CODEC_KEYS: ReadonlySet<string> = new Set<string>(EXACT_NUMERIC_TYPES);

/**
 * Codec key for a declared SQL type, or `undefined` when the type needs none.
 * The width is stripped, so `numeric(19,4)` and `numeric` share one codec — the
 * codec re-reads the full type from the column when it matters.
 */
function codecKey(dataType: string): string | undefined {
  // Cut at the parenthesis rather than with /\s*\(.*$/, which backtracks
  // quadratically on a long run of spaces.
  const paren = dataType.indexOf("(");
  const base = (paren === -1 ? dataType : dataType.slice(0, paren)).trimEnd().toLowerCase();
  return CODEC_KEYS.has(base) ? base : undefined;
}

// ---------------------------------------------------------------------------
// SybaseColumn — the built column instance attached to tables
// ---------------------------------------------------------------------------

/**
 * Column instance that is attached to tables. Recognized by drizzle-orm's
 * `is(col, Column)` because our prototype chain includes a class with
 * `static [entityKind] = "Column"`.
 */
export class SybaseColumn<
  T extends SybaseColumnTypeConfig = SybaseColumnTypeConfig,
  TTableKey extends string = string
> {
  static [entityKind] = "SybaseColumn";

  /** Type-level description of the column (phantom: absent at runtime). */
  declare readonly _: T & { tableKey: TTableKey };

  // Properties expected by drizzle-orm sql.js when processing Column chunks
  name: string;
  table: any;
  isAlias = false;

  // Properties used by our query builders
  primary: boolean;
  notNull: boolean;
  default: unknown;
  defaultFn?: () => unknown;
  onUpdateFn?: () => unknown;
  hasDefault: boolean;
  dataType: string;
  columnType: string;
  identity: boolean;
  /**
   * Codec key read by drizzle-orm when it inlines a parameter, so types that
   * need a CONVERT around the literal get one in WHERE / JOIN ... ON / HAVING
   * too — those build their SQL from drizzle's chunks, not through
   * `SybaseDialect#serializeColumnValue`. Left undefined for types that need no
   * codec, which makes the lookup a no-op.
   */
  codec: string | undefined;
  /**
   * Applied by the dialect when a value is written. There is deliberately no
   * read-side counterpart: results are decoded from the type metadata the addon
   * reports (see `columnTypes`), and by then the schema that produced the query
   * is no longer in hand — `db.select()` may return `*`, joined columns can share
   * a name, and an aggregate belongs to no column at all. A hook that silently
   * applied to some of those and not others would be worse than none.
   */
  mapToDriverValue: (value: any) => any;

  constructor(table: any, config: SybaseColumnConfig) {
    this.table = table;
    this.name = config.name;
    this.primary = config.primaryKey ?? false;
    this.notNull = config.notNull ?? false;
    this.default = config.default;
    this.defaultFn = config.defaultFn;
    this.onUpdateFn = config.onUpdateFn;
    this.hasDefault = config.hasDefault ?? false;
    this.dataType = config.dataType ?? "string";
    this.columnType = config.columnType ?? "SybaseColumn";
    this.identity = config.identity ?? false;
    this.codec = codecKey(this.dataType);
    this.mapToDriverValue = config.mapToDriverValue ?? ((v: any) => v);
  }

  getSQLType(): string {
    return this.dataType;
  }

  shouldDisableInsert(): boolean {
    return this.identity;
  }

  // SQLWrapper interface — required for drizzle-orm sql template embedding
  getSQL(): SQL<SybaseColumnRead<this>> {
    // Return a minimal SQL wrapper that references this column.
    // The actual SQL generation happens in drizzle-orm's sql.js buildQueryFromSourceParams
    // which checks `is(chunk, Column)` and reads chunk.name/chunk.table directly.
    return { queryChunks: [this] } as unknown as SQL<SybaseColumnRead<this>>;
  }

  /**
   * The column under an alias, as drizzle's `column.as()`: in SQL it renders as
   * the alias alone (e.g. to order by a select alias); as a select field it
   * selects this column.
   */
  as(alias: string): this {
    return aliasedColumn(this as never, alias) as never;
  }

  /** @internal What drizzle's alias proxy resolves back to. */
  [OriginalColumn](): this {
    return this;
  }
}

// Make SybaseColumn pass `is(col, Column)` by inserting a marker
// with entityKind = "Column" in the prototype chain.
function _createColumnMarker() {
  function DrizzleColumnMarker() {}
  Object.defineProperty(DrizzleColumnMarker, entityKind, { value: "Column" });
  return DrizzleColumnMarker;
}
const _ColumnMarker = _createColumnMarker();
Object.setPrototypeOf(SybaseColumn.prototype, _ColumnMarker.prototype);
Object.setPrototypeOf(SybaseColumn, _ColumnMarker);

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface SybaseColumnConfig {
  name: string;
  primaryKey?: boolean;
  notNull?: boolean;
  default?: unknown;
  defaultFn?: () => unknown;
  onUpdateFn?: () => unknown;
  hasDefault?: boolean;
  dataType?: string;
  columnType?: string;
  identity?: boolean;
  mapToDriverValue?: (value: any) => any;
}

// ---------------------------------------------------------------------------
// SybaseColumnBuilder — fluent builder used in table definitions
// ---------------------------------------------------------------------------

export class SybaseColumnBuilder<T extends SybaseColumnTypeConfig = SybaseColumnTypeConfig> {
  /** Type-level description of the column (phantom: absent at runtime). */
  declare readonly _: T;

  /** @internal */
  _config: SybaseColumnConfig;

  constructor(name: string, sqlType: string) {
    this._config = {
      name,
      dataType: sqlType,
      columnType: "SybaseColumn",
      primaryKey: false,
      notNull: false,
      hasDefault: false,
      identity: false
    };
  }

  primaryKey(): SybaseColumnBuilder<With<T, { notNull: true }>> {
    this._config.primaryKey = true;
    this._config.notNull = true;
    return this as never;
  }

  notNull(): SybaseColumnBuilder<With<T, { notNull: true }>> {
    this._config.notNull = true;
    return this as never;
  }

  identity(): SybaseColumnBuilder<With<T, { identity: true }>> {
    this._config.identity = true;
    return this as never;
  }

  /**
   * Declare the default the database applies (the column's `DEFAULT`), as in
   * drizzle: an insert may omit the column, and the driver then leaves it out
   * of the statement so the server fills it. `value` is documentation only —
   * it is never sent. For a default computed by the client, use
   * {@link $defaultFn}.
   */
  default(value: T["write"] | SQLWrapper): SybaseColumnBuilder<With<T, { hasDefault: true }>> {
    this._config.default = value;
    this._config.hasDefault = true;
    return this as never;
  }

  /**
   * The database supplies a value when an insert omits the column (a `DEFAULT`
   * constraint or a bound default), so inserts may leave it out. Like
   * {@link default}, without stating the value — what the schema generator
   * emits, since a catalog default is SQL text rather than a JS value.
   */
  hasDatabaseDefault(): SybaseColumnBuilder<With<T, { hasDefault: true }>> {
    this._config.hasDefault = true;
    return this as never;
  }

  $defaultFn(
    fn: () => T["write"] | SQLWrapper
  ): SybaseColumnBuilder<With<T, { hasDefault: true }>> {
    this._config.defaultFn = fn;
    this._config.hasDefault = true;
    return this as never;
  }

  /** Also applied on insert when the column is omitted, so inserts may leave it out. */
  $onUpdateFn(
    fn: () => T["write"] | SQLWrapper
  ): SybaseColumnBuilder<With<T, { hasDefault: true }>> {
    this._config.onUpdateFn = fn;
    return this as never;
  }

  /**
   * Set a custom mapToDriverValue function for this column. The values an
   * insert or update accepts become what `fn` takes; reads are unaffected
   * (there is no read-side hook — see `SybaseColumn#mapToDriverValue`).
   */
  $mapToDriver<TInput>(
    fn: (value: TInput) => T["write"]
  ): SybaseColumnBuilder<With<T, { write: TInput }>> {
    this._config.mapToDriverValue = fn;
    return this as never;
  }

  /**
   * Narrow the column's value type, e.g. to a union of string literals. Types
   * only: the driver still returns what the SQL type decodes to, so `TData`
   * must be a subtype of it.
   */
  $type<TData extends T["data"] & T["write"]>(): SybaseColumnBuilder<
    With<T, { data: TData; write: TData }>
  > {
    return this as never;
  }

  /** @internal — called by sybaseTable to produce the final Column object */
  build<TTableKey extends string>(table: any): SybaseColumn<T, TTableKey> {
    return new SybaseColumn(table, this._config);
  }
}

// ---------------------------------------------------------------------------
// Column type factory functions
// ---------------------------------------------------------------------------

// The declared value types mirror how `binding.c` decodes each SQL type (and
// `datetime.ts` for the temporal ones); `type-map.ts` holds the same mapping
// for the code generator. A test checks all three agree against a live server.

const column = <TData, TWrite = TData>(name: string, sqlType: string) =>
  new SybaseColumnBuilder<ColumnOf<TData, TWrite>>(name, sqlType);

export const int = (name: string) => column<number>(name, "int");
/** 64-bit: read as a `BigInt`; written from a `BigInt` or a digit string, never a lossy `number`. */
export const bigint = (name: string) => column<bigint, bigint | string>(name, "bigint");
export const smallint = (name: string) => column<number>(name, "smallint");
export const tinyint = (name: string) => column<number>(name, "tinyint");
export const unsignedSmallint = (name: string) => column<number>(name, "unsigned smallint");
/** Up to 4294967295: past an `int`, but exact in a `number`. */
export const unsignedInt = (name: string) => column<number>(name, "unsigned int");
/** Up to 18446744073709551615: read as a `BigInt`; written from a `BigInt` or a digit string. */
export const unsignedBigint = (name: string) =>
  column<bigint, bigint | string>(name, "unsigned bigint");

/**
 * A type whose width is a single length, e.g. `varchar(30)`.
 *
 * A length of 0 is treated as absent, so the type is emitted bare — ASE supplies
 * its own default and a `varchar(0)` would be rejected.
 */
const sizedByLength =
  <TData>(type: string) =>
  (name: string, opts?: { length?: number }) =>
    column<TData>(name, opts?.length ? `${type}(${opts.length})` : type);

/**
 * A fixed-point type whose width is a precision and an optional scale, e.g.
 * `numeric(19,4)`. Read as a digit string; what it accepts on write depends on
 * the width (see {@link DecimalWrite}), so the width is captured as literals.
 */
const sizedByPrecision =
  (type: string) =>
  <const O extends { precision?: number; scale?: number } = Record<never, never>>(
    name: string,
    opts?: O
  ) => {
    const sqlType =
      opts?.precision === undefined
        ? type
        : opts.scale === undefined
          ? `${type}(${opts.precision})`
          : `${type}(${opts.precision},${opts.scale})`;
    return column<string, DecimalWrite<OptionOf<O, "precision">, OptionOf<O, "scale">>>(
      name,
      sqlType
    );
  };

export const varchar = sizedByLength<string>("varchar");
export const nvarchar = sizedByLength<string>("nvarchar");
export const char = sizedByLength<string>("char");
export const nchar = sizedByLength<string>("nchar");
export const univarchar = sizedByLength<string>("univarchar");
export const unichar = sizedByLength<string>("unichar");
export const text = (name: string) => column<string>(name, "text");
/**
 * ASE has no `ntext` type — use `text`, or `unitext` for Unicode. Kept so
 * existing schemas compile; it behaves exactly like `text`.
 *
 * @deprecated ASE has no `ntext` type.
 */
export const ntext = (name: string) => column<string>(name, "ntext");
/**
 * Unicode text, read and written as UTF-16LE bytes. db-lib receives it as an
 * image, so reads arrive undecoded; and a string literal is converted through
 * the server charset, which mangles anything it cannot represent. Raw bytes
 * round-trip exactly (checked against ASE 15.7):
 * `Buffer.from(text, "utf16le")` to write, `buffer.toString("utf16le")` to read.
 */
export const unitext = (name: string) => column<Buffer>(name, "unitext");

export const datetime = (name: string) => column<Date>(name, "datetime");
export const smalldatetime = (name: string) => column<Date>(name, "smalldatetime");
/**
 * A calendar date (`YYYY-MM-DD`). Read as text, not a `Date`: it is not an
 * instant, and a `Date` would place it in some time zone.
 */
export const date = (name: string) => column<string>(name, "date");
/** A time of day (`HH:MM:SS.mmm`), read as text for the same reason as {@link date}. */
export const time = (name: string) => column<string>(name, "time");
/** Microsecond precision, finer than a `Date` holds: read and written as text. */
export const bigdatetime = (name: string) => column<string>(name, "bigdatetime");
/** Microsecond precision, finer than a `Date` holds: read and written as text. */
export const bigtime = (name: string) => column<string>(name, "bigtime");

export const numeric = sizedByPrecision("numeric");
export const decimal = sizedByPrecision("decimal");

export const float = (name: string) => column<number>(name, "float");
export const real = (name: string) => column<number>(name, "real");
/** `money` is numeric(19,4): wider than a double, so it is written from digit strings only. */
export const money = (name: string) => column<string, string>(name, "money");
/** `smallmoney` is numeric(10,4): a double holds it, so a `number` is accepted too. */
export const smallmoney = (name: string) => column<string, number | string>(name, "smallmoney");

export const bit = (name: string) => column<boolean>(name, "bit");

export const binary = sizedByLength<Buffer>("binary");
export const varbinary = sizedByLength<Buffer>("varbinary");
export const image = (name: string) => column<Buffer>(name, "image");
