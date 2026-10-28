/**
 * Query results as the native addon hands them over — column by column — and
 * their conversion to what the driver returns: decoded columns
 * ({@link SybaseColumnarResult}) or row objects.
 *
 * The addon does as little as possible on the JS thread: fixed-width values
 * arrive as one typed array per column and text as a few strings, cut by length,
 * per column (see `build_result` in `binding.c`). Rows are then built here by a
 * function compiled for the result's column list, which V8 turns into
 * straight-line object-literal allocation.
 */
import { resolveWallClocks } from "./datetime.js";

// ---------------------------------------------------------------------------
// The addon's result
// ---------------------------------------------------------------------------

interface NativeColumnOf<K extends string, V> {
  kind: K;
  values: V;
  /** 1 where the value is NULL; absent when the column has none. */
  nulls: Uint8Array | undefined;
}

/**
 * One column as the native addon hands it over.
 *
 * @internal
 */
export type NativeColumn =
  /**
   * `values` holds runs of consecutive values back to back; `units` each value's
   * length in UTF-16 code units, by which the runs are cut.
   */
  | (NativeColumnOf<"text", string[]> & { units: Uint32Array })
  /** `values` holds every value back to back; `ends` the offset just past each. */
  | (NativeColumnOf<"binary", Buffer> & { ends: Float64Array })
  | NativeColumnOf<"int32", Int32Array>
  | NativeColumnOf<"float64", Float64Array>
  | NativeColumnOf<"int64", BigInt64Array>
  | NativeColumnOf<"uint64", BigUint64Array>
  | NativeColumnOf<"bool", Uint8Array>
  /** `datetime` / `smalldatetime` wall clocks, as the ms they would be in UTC. */
  | NativeColumnOf<"wallclock", Float64Array>;

/**
 * A query result as the native addon hands it over.
 *
 * @internal
 */
export interface NativeResult {
  columns: string[];
  columnTypes: string[];
  data: NativeColumn[];
  rowCount: number;
  affectedRows: number;
}

// ---------------------------------------------------------------------------
// Columnar result
// ---------------------------------------------------------------------------

/**
 * The values of one result column, one per row.
 *
 * Fixed-width columns are typed arrays: `Int32Array` for `tinyint`, `smallint`
 * and `int`; `Float64Array` for `float`, `real`, `usmallint` and `uint`;
 * `BigInt64Array` for `bigint`; `BigUint64Array` for `ubigint`; and, read
 * through a session, `Float64Array` of epoch milliseconds for `datetime` /
 * `smalldatetime` — the instant a row result's `Date` holds, without a ~100-byte
 * object per value (`new Date(ms)` gives the same `Date`). A typed array cannot
 * hold `null`, so a NULL reads as `0` there — check
 * {@link SybaseResultColumn.nulls}.
 *
 * Every other column is a plain array holding `null` for NULL: `boolean` for
 * `bit`, `Buffer` for binary types, and `string` for the rest — including
 * `money` and `numeric`, which a JS number cannot hold exactly, and
 * `datetime` / `smalldatetime` read through a pool or connection (canonical
 * text, as in their row results).
 */
export type SybaseColumnValues =
  | Int32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | (string | null)[]
  | (boolean | null)[]
  | (Buffer | null)[];

/** One column of a {@link SybaseColumnarResult}. */
export interface SybaseResultColumn {
  /** Column name (or alias) as the server reports it. */
  name: string;
  /** Sybase system type name: `int`, `varchar`, `datetime`, `money`, ... */
  type: string;
  values: SybaseColumnValues;
  /**
   * 1 where the value is NULL, 0 elsewhere; `undefined` when the column holds
   * no NULLs. Needed for typed-array `values`, which cannot hold `null`.
   */
  nulls: Uint8Array | undefined;
}

/**
 * A result set column by column — the form bulk consumers (Arrow, DuckDB,
 * Parquet writers) take, without building an object per row.
 */
export interface SybaseColumnarResult {
  /** The columns, in select-list order. */
  columns: SybaseResultColumn[];
  rowCount: number;
  affectedRows: number;
}

/**
 * A result written to a CSV file rather than returned (`queryToFile` /
 * `executeToFile`).
 *
 * The file is RFC 4180 CSV in UTF-8: a header row of column names, `,` between
 * fields, `\n` after each row, a field quoted with `"` when it holds a comma,
 * quote, line break or NUL, is empty, or starts or ends with a blank, and `"` doubled
 * inside quotes. **NULL is an empty unquoted field; an empty string is `""`.**
 * Values are what a row result holds, as text: numbers in decimal (floats in
 * the fewest significant digits, 15–17, that read back as the same double),
 * `bit` as `true`/`false`, `money` and `numeric` exactly, datetime types as
 * their canonical text — the stored wall clock, not converted to any zone — and
 * binary as lowercase hex, empty bytes as `""`.
 *
 * The file is written beside the target and renamed into place on success: a
 * failed query leaves an existing file as it was and no partial one behind.
 *
 * DuckDB reads it with
 * `read_csv(path, header = true, quote = '"', escape = '"', nullstr = '',
 * allow_quoted_nulls = false, auto_detect = false, columns = {...})`, the column
 * types chosen from {@link columnTypes}.
 */
export interface SybaseFileResult {
  /** Column names, in file order. */
  columns: string[];
  /** Sybase system type name per column, in column order. */
  columnTypes: string[];
  /** Rows written (a number: may pass 2^31). */
  rowCount: number;
  affectedRows: number;
  /** Bytes written. */
  bytes: number;
}

/** A NULL marker that is set, read the way the addon writes it. */
const isNull = (nulls: Uint8Array | undefined, row: number): boolean =>
  nulls !== undefined && nulls[row] === 1;

/** Cut a text column's runs back into one value per row, by each value's UTF-16 length. */
const cutText = (
  name: string,
  runs: string[],
  units: Uint32Array,
  nulls: Uint8Array | undefined,
  rowCount: number
): (string | null)[] => {
  const values = new Array<string | null>(rowCount);
  let row = 0;
  for (const run of runs) {
    let start = 0;
    while (start < run.length && row < rowCount) {
      const end = start + units[row]!;
      values[row++] = run.slice(start, end);
      start = end;
    }
    if (start !== run.length) {
      row = -1;
      break;
    }
  }
  // Empty values after the last non-empty one end no run.
  while (row >= 0 && row < rowCount && units[row] === 0) {
    values[row++] = "";
  }
  if (row !== rowCount) {
    throw new Error(
      `drizzle-sybase: column ${JSON.stringify(name)} does not cut into ${rowCount} values. ` +
        "The native addon and the JS layer are out of sync — reinstall drizzle-sybase."
    );
  }
  if (nulls !== undefined) {
    for (let i = 0; i < rowCount; i++) {
      if (nulls[i] === 1) {
        values[i] = null;
      }
    }
  }
  return values;
};

/**
 * Resolve a datetime column's wall clocks to instants (ms since the epoch), in
 * place: the array is the addon's own, used nowhere else.
 */
const toInstants = (
  name: string,
  wallClocks: Float64Array,
  nulls: Uint8Array | undefined,
  timeZone: string
): Float64Array => {
  const failed = resolveWallClocks(wallClocks, nulls, timeZone);
  if (failed >= 0) {
    throw new Error(
      `Could not decode datetime column ${JSON.stringify(name)}: the wall clock ` +
        `${new Date(wallClocks[failed]!).toISOString().slice(0, 23)} does not resolve to an instant in ${timeZone}`
    );
  }
  return wallClocks;
};

const copyOf = Uint8Array.prototype.slice;

/**
 * Cut a binary column into one Buffer per value. Each is a copy with memory of
 * its own (`byteOffset` 0, `buffer` exactly its bytes), as a Buffer created per
 * value would be — not a view that would keep the whole column alive.
 */
const splitBinary = (
  bytes: Buffer,
  ends: Float64Array,
  nulls: Uint8Array | undefined
): (Buffer | null)[] => {
  const values = new Array<Buffer | null>(ends.length);
  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i]!;
    values[i] = isNull(nulls, i) ? null : (copyOf.call(bytes, start, end) as Buffer);
    start = end;
  }
  return values;
};

const toBooleans = (bits: Uint8Array, nulls: Uint8Array | undefined): (boolean | null)[] => {
  const values = new Array<boolean | null>(bits.length);
  for (let i = 0; i < bits.length; i++) {
    values[i] = isNull(nulls, i) ? null : bits[i] !== 0;
  }
  return values;
};

const decodeValues = (
  name: string,
  column: NativeColumn,
  rowCount: number,
  timeZone: string | undefined
): SybaseColumnValues => {
  switch (column.kind) {
    case "text":
      // An addon from an older build hands over \0-joined runs and no lengths.
      if (!(column.units instanceof Uint32Array)) {
        throw new Error(
          "drizzle-sybase: the loaded native addon predates the JS layer (no text lengths in its " +
            "result). Reinstall drizzle-sybase so the bundled addon matches."
        );
      }
      return cutText(name, column.values, column.units, column.nulls, rowCount);
    case "binary":
      return splitBinary(column.values, column.ends, column.nulls);
    case "bool":
      return toBooleans(column.values, column.nulls);
    case "wallclock":
      if (timeZone === undefined) {
        throw new Error("drizzle-sybase: datetime wall clocks arrived without a time zone");
      }
      return toInstants(name, column.values, column.nulls, timeZone);
    default:
      return column.values;
  }
};

/**
 * Decode the addon's result into columns.
 *
 * `timeZone` must be given when the query asked for datetime wall clocks.
 *
 * @internal
 */
export const toColumnarResult = (raw: NativeResult, timeZone?: string): SybaseColumnarResult => ({
  columns: raw.data.map((column, i) => ({
    name: raw.columns[i]!,
    type: raw.columnTypes[i]!,
    values: decodeValues(raw.columns[i]!, column, raw.rowCount, timeZone),
    nulls: column.nulls
  })),
  rowCount: raw.rowCount,
  affectedRows: raw.affectedRows
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Builds the row objects for one column list. */
type RowBuilder = (
  values: (SybaseColumnValues | (Date | null)[])[],
  nulls: (Uint8Array | undefined)[],
  rowCount: number
) => Record<string, unknown>[];

/** Sybase types read as `Date` in rows. */
const DATE_TYPES: ReadonlySet<string> = new Set(["datetime", "smalldatetime"]);

/** Fills `dates[start..end)` from epoch milliseconds, `null` where masked. */
const fillDates = (
  instants: Float64Array,
  nulls: Uint8Array | undefined,
  dates: (Date | null)[],
  start: number,
  end: number
): void => {
  for (let i = start; i < end; i++) {
    dates[i] = isNull(nulls, i) ? null : new Date(instants[i]!);
  }
};

/**
 * A datetime column's epoch milliseconds as the `Date`s rows hold. Created in
 * a pass of their own, in short calls (see {@link ROWS_PER_FILL}): measured
 * faster than creating them inside the row literal, by ~70 ms per 1M rows.
 */
const toDates = (instants: Float64Array, nulls: Uint8Array | undefined): (Date | null)[] => {
  const dates = new Array<Date | null>(instants.length);
  for (let start = 0; start < instants.length; start += ROWS_PER_FILL) {
    fillDates(instants, nulls, dates, start, Math.min(instants.length, start + ROWS_PER_FILL));
  }
  return dates;
};

/** A column as rows read it: datetime instants become `Date`s. */
const rowValues = (column: SybaseResultColumn): SybaseColumnValues | (Date | null)[] =>
  column.values instanceof Float64Array && DATE_TYPES.has(column.type)
    ? toDates(column.values, column.nulls)
    : column.values;

/**
 * Whether a field reads through the column's NULL mask: typed arrays cannot
 * hold `null`, plain arrays hold it in place.
 */
const isMasked = (values: SybaseColumnValues | (Date | null)[], nulls: Uint8Array | undefined) =>
  nulls !== undefined && ArrayBuffer.isView(values);

/** Fills `rows[start..end)` for one column list. */
type RowFiller = (
  values: (SybaseColumnValues | (Date | null)[])[],
  nulls: (Uint8Array | undefined)[],
  rows: Record<string, unknown>[],
  start: number,
  end: number
) => void;

/**
 * Rows filled per call of a compiled filler. One loop over a whole large result
 * is entered once and optimized mid-loop; V8 then tends to deoptimize it when
 * it starts allocating the long-lived rows in old space, and the rest of the
 * loop runs an order of magnitude slower (measured: ~1 s instead of ~50 ms for
 * 1M rows, in most runs). Short calls are optimized as a whole and stay fast.
 */
const ROWS_PER_FILL = 4096;

/**
 * A builder specialised for the column list: one object literal with every
 * field in place, so all rows share one hidden class and V8 allocates each in
 * a single step — about four times faster than adding the fields one by one.
 *
 * Column names are embedded with `JSON.stringify`, which always yields a valid
 * JS string literal, as computed keys — so a column named `__proto__` becomes an
 * own property rather than replacing the prototype.
 */
const compileBuilder = (names: string[], masked: boolean[]): RowBuilder => {
  const fields = names.map(
    (name, i) =>
      `[${JSON.stringify(name)}]: ${masked[i] ? `n${i}[r] === 1 ? null : v${i}[r]` : `v${i}[r]`}`
  );
  const body = [
    ...names.map((_, i) => `const v${i} = values[${i}], n${i} = nulls[${i}];`),
    "for (let r = start; r < end; r++) {",
    `  rows[r] = { ${fields.join(", ")} };`,
    "}"
  ].join("\n");
  // oxlint-disable-next-line typescript/no-implied-eval -- the body is generated above, never from input; see compileBuilder
  const fill = new Function("values", "nulls", "rows", "start", "end", body) as RowFiller;
  return (values, nulls, rowCount) => {
    const rows = new Array<Record<string, unknown>>(rowCount);
    for (let start = 0; start < rowCount; start += ROWS_PER_FILL) {
      fill(values, nulls, rows, start, Math.min(rowCount, start + ROWS_PER_FILL));
    }
    return rows;
  };
};

/** Field by field, for runtimes that disallow compiling code from strings. */
const genericBuilder = (names: string[], masked: boolean[]): RowBuilder => {
  // Defined rather than assigned, to match the compiled builder: an assignment
  // to `__proto__` would replace the prototype.
  const define = names.map(name => name === "__proto__");
  return (values, nulls, rowCount) => {
    const rows = new Array<Record<string, unknown>>(rowCount);
    for (let r = 0; r < rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (let c = 0; c < names.length; c++) {
        const value = masked[c] && nulls[c]![r] === 1 ? null : values[c]![r];
        if (define[c]) {
          Object.defineProperty(row, names[c]!, {
            value,
            writable: true,
            enumerable: true,
            configurable: true
          });
        } else {
          row[names[c]!] = value;
        }
      }
      rows[r] = row;
    }
    return rows;
  };
};

/** Builders by column list; a long-lived process sees a bounded set of queries. */
const builders = new Map<string, RowBuilder>();
const MAX_CACHED_BUILDERS = 512;

/** Cleared when the runtime refuses `new Function` (`--disallow-code-generation-from-strings`). */
let canCompile = true;

const rowBuilder = (names: string[], masked: boolean[]): RowBuilder => {
  const key = `${masked.map(Number).join("")}${JSON.stringify(names)}`;
  let builder = builders.get(key);
  if (builder) {
    return builder;
  }
  if (canCompile) {
    try {
      builder = compileBuilder(names, masked);
    } catch (err) {
      if (!(err instanceof EvalError)) {
        throw err;
      }
      canCompile = false;
    }
  }
  builder ??= genericBuilder(names, masked);
  if (builders.size >= MAX_CACHED_BUILDERS) {
    builders.clear();
  }
  builders.set(key, builder);
  return builder;
};

/**
 * Row objects keyed by column name, in column order. A later column with the
 * same name as an earlier one overwrites its value.
 *
 * @internal
 */
export const buildRows = (columnar: SybaseColumnarResult): Record<string, unknown>[] => {
  const { columns, rowCount } = columnar;
  if (rowCount === 0) {
    return [];
  }
  const values = columns.map(rowValues);
  const builder = rowBuilder(
    columns.map(column => column.name),
    columns.map((column, i) => isMasked(values[i]!, column.nulls))
  );
  return builder(
    values,
    columns.map(column => column.nulls),
    rowCount
  );
};

/**
 * The row form of the addon's result.
 *
 * @internal
 */
export const toRowResult = (
  raw: NativeResult,
  timeZone?: string
): {
  rows: Record<string, unknown>[];
  columns: string[];
  columnTypes: string[];
  rowCount: number;
  affectedRows: number;
} => ({
  rows: buildRows(toColumnarResult(raw, timeZone)),
  columns: raw.columns,
  columnTypes: raw.columnTypes,
  rowCount: raw.rowCount,
  affectedRows: raw.affectedRows
});
