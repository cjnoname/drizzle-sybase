/**
 * Sybase column type builders.
 *
 * Creates column objects that pass drizzle-orm's `is(col, Column)` check
 * by using the same entityKind symbol mechanism. This ensures compatibility
 * with drizzle-orm operators (eq, ne, gt, sql template, etc.).
 *
 * Does NOT depend on drizzle-orm/mssql-core.
 */

import { EXACT_NUMERIC_TYPES } from "../codecs.js";

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
  const base = dataType.replace(/\s*\(.*$/, "").toLowerCase();
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
export class SybaseColumn {
  static [entityKind] = "SybaseColumn";

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
  getSQL(): any {
    // Return a minimal SQL wrapper that references this column.
    // The actual SQL generation happens in drizzle-orm's sql.js buildQueryFromSourceParams
    // which checks `is(chunk, Column)` and reads chunk.name/chunk.table directly.
    return { queryChunks: [this] };
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

export class SybaseColumnBuilder {
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

  primaryKey(): this {
    this._config.primaryKey = true;
    this._config.notNull = true;
    return this;
  }

  notNull(): this {
    this._config.notNull = true;
    return this;
  }

  identity(): this {
    this._config.identity = true;
    return this;
  }

  default(value: unknown): this {
    this._config.default = value;
    this._config.hasDefault = true;
    return this;
  }

  $defaultFn(fn: () => unknown): this {
    this._config.defaultFn = fn;
    this._config.hasDefault = true;
    return this;
  }

  $onUpdateFn(fn: () => unknown): this {
    this._config.onUpdateFn = fn;
    return this;
  }

  /**
   * Set a custom mapToDriverValue function for this column.
   */
  $mapToDriver(fn: (value: any) => any): this {
    this._config.mapToDriverValue = fn;
    return this;
  }

  /** @internal — called by sybaseTable to produce the final Column object */
  build(table: any): SybaseColumn {
    return new SybaseColumn(table, this._config);
  }
}

// ---------------------------------------------------------------------------
// Column type factory functions
// ---------------------------------------------------------------------------

export const int = (name: string) => new SybaseColumnBuilder(name, "int");
export const bigint = (name: string) => new SybaseColumnBuilder(name, "bigint");
export const smallint = (name: string) => new SybaseColumnBuilder(name, "smallint");
export const tinyint = (name: string) => new SybaseColumnBuilder(name, "tinyint");

/**
 * A type whose width is a single length, e.g. `varchar(30)`.
 *
 * A length of 0 is treated as absent, so the type is emitted bare — ASE supplies
 * its own default and a `varchar(0)` would be rejected.
 */
const sizedByLength =
  (type: string) =>
  (name: string, opts?: { length?: number }): SybaseColumnBuilder =>
    new SybaseColumnBuilder(name, opts?.length ? `${type}(${opts.length})` : type);

/** A type whose width is a precision and an optional scale, e.g. `numeric(19,4)`. */
const sizedByPrecision =
  (type: string) =>
  (name: string, opts?: { precision?: number; scale?: number }): SybaseColumnBuilder => {
    if (opts?.precision === undefined) {
      return new SybaseColumnBuilder(name, type);
    }
    const width =
      opts.scale === undefined ? `${opts.precision}` : `${opts.precision},${opts.scale}`;
    return new SybaseColumnBuilder(name, `${type}(${width})`);
  };

export const varchar = sizedByLength("varchar");
export const nvarchar = sizedByLength("nvarchar");
export const char = sizedByLength("char");
export const nchar = sizedByLength("nchar");
export const text = (name: string) => new SybaseColumnBuilder(name, "text");
export const ntext = (name: string) => new SybaseColumnBuilder(name, "ntext");

export const datetime = (name: string) => new SybaseColumnBuilder(name, "datetime");
export const smalldatetime = (name: string) => new SybaseColumnBuilder(name, "smalldatetime");

export const numeric = sizedByPrecision("numeric");
export const decimal = sizedByPrecision("decimal");

export const float = (name: string) => new SybaseColumnBuilder(name, "float");
export const real = (name: string) => new SybaseColumnBuilder(name, "real");
export const money = (name: string) => new SybaseColumnBuilder(name, "money");
export const smallmoney = (name: string) => new SybaseColumnBuilder(name, "smallmoney");

export const bit = (name: string) => new SybaseColumnBuilder(name, "bit");

export const binary = sizedByLength("binary");
export const varbinary = sizedByLength("varbinary");
export const image = (name: string) => new SybaseColumnBuilder(name, "image");
