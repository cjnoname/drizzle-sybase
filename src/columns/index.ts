/**
 * Sybase column type builders.
 *
 * Creates column objects that pass drizzle-orm's `is(col, Column)` check
 * by using the same entityKind symbol mechanism. This ensures compatibility
 * with drizzle-orm operators (eq, ne, gt, sql template, etc.).
 *
 * Does NOT depend on drizzle-orm/mssql-core.
 */

// We use the entityKind symbol to make our classes recognized by drizzle-orm's
// `is()` function without needing to extend the heavily-generic base classes.
const entityKind = Symbol.for("drizzle:entityKind");

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
  mapFromDriverValue: (value: any) => any;
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
    this.mapFromDriverValue = config.mapFromDriverValue ?? ((v: any) => v);
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
  mapFromDriverValue?: (value: any) => any;
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

  /**
   * Set a custom mapFromDriverValue function for this column.
   */
  $mapFromDriver(fn: (value: any) => any): this {
    this._config.mapFromDriverValue = fn;
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

export const varchar = (name: string, opts?: { length?: number }) =>
  new SybaseColumnBuilder(name, opts?.length ? `varchar(${opts.length})` : "varchar");
export const nvarchar = (name: string, opts?: { length?: number }) =>
  new SybaseColumnBuilder(name, opts?.length ? `nvarchar(${opts.length})` : "nvarchar");
export const char = (name: string, opts?: { length?: number }) =>
  new SybaseColumnBuilder(name, opts?.length ? `char(${opts.length})` : "char");
export const nchar = (name: string, opts?: { length?: number }) =>
  new SybaseColumnBuilder(name, opts?.length ? `nchar(${opts.length})` : "nchar");
export const text = (name: string) => new SybaseColumnBuilder(name, "text");
export const ntext = (name: string) => new SybaseColumnBuilder(name, "ntext");

export const datetime = (name: string) => new SybaseColumnBuilder(name, "datetime");
export const smalldatetime = (name: string) => new SybaseColumnBuilder(name, "smalldatetime");

export const numeric = (name: string, opts?: { precision?: number; scale?: number }) => {
  let type = "numeric";
  if (opts?.precision !== undefined) {
    type =
      opts.scale !== undefined
        ? `numeric(${opts.precision},${opts.scale})`
        : `numeric(${opts.precision})`;
  }
  return new SybaseColumnBuilder(name, type);
};

export const decimal = (name: string, opts?: { precision?: number; scale?: number }) => {
  let type = "decimal";
  if (opts?.precision !== undefined) {
    type =
      opts.scale !== undefined
        ? `decimal(${opts.precision},${opts.scale})`
        : `decimal(${opts.precision})`;
  }
  return new SybaseColumnBuilder(name, type);
};

export const float = (name: string) => new SybaseColumnBuilder(name, "float");
export const real = (name: string) => new SybaseColumnBuilder(name, "real");
export const money = (name: string) => new SybaseColumnBuilder(name, "money");
export const smallmoney = (name: string) => new SybaseColumnBuilder(name, "smallmoney");

export const bit = (name: string) => new SybaseColumnBuilder(name, "bit");

export const binary = (name: string, opts?: { length?: number }) =>
  new SybaseColumnBuilder(name, opts?.length ? `binary(${opts.length})` : "binary");
export const varbinary = (name: string, opts?: { length?: number }) =>
  new SybaseColumnBuilder(name, opts?.length ? `varbinary(${opts.length})` : "varbinary");
export const image = (name: string) => new SybaseColumnBuilder(name, "image");
