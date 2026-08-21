/**
 * Single source of truth mapping Sybase ASE system type names to:
 *   - the drizzle-sybase column factory (`int`, `varchar`, ...),
 *   - the corresponding Zod validator,
 *   - the TypeScript value type.
 *
 * Every code generator (column builders, Zod schemas, import collection) reads
 * from this one registry, so adding a type — or fixing a mapping — happens in
 * exactly one place and can never drift between generators.
 *
 * The set of factory names here is kept in lock-step with the exports of
 * `../columns/index.ts`.
 */

import type { ColumnMeta } from "./types.js";

/** How a Sybase type renders its size modifier in a column builder call. */
export type SizeKind =
  /** No size argument, e.g. `int("c")`. */
  | "none"
  /** `{ length: n }`, e.g. `varchar("c", { length: 10 })`. */
  | "length"
  /** `{ precision: p, scale: s }`, e.g. `numeric("c", { precision: 10, scale: 2 })`. */
  | "precision";

/** The JS value category a column maps to (drives the Zod validator). */
export type ValueKind =
  | "number"
  | "boolean"
  | "date"
  | "buffer"
  | "string"
  /**
   * Exact fixed-point types (`numeric`, `decimal`, `money`, `smallmoney`). The
   * native driver returns these as strings on purpose so no digits are lost in
   * transit, so that is what a select schema must say. How wide a value a caller
   * may *write* is a property of the column — see {@link decimalRepresentation}.
   */
  | "decimal"
  /**
   * 64-bit integers. Unlike the fixed-point types these arrive as a real JS
   * `BigInt` (see `napi_create_bigint_int64` in `binding.c`), because that is
   * exact and needs no parsing.
   */
  | "bigint";

/** Declared width of a fixed-point column. */
export interface DecimalWidth {
  precision: number;
  scale: number;
}

export interface TypeMapping {
  /** drizzle-sybase column factory name (also the import identifier). */
  factory: string;
  size: SizeKind;
  value: ValueKind;
  /**
   * National (Unicode) char types store byte length in the catalog but the
   * builder/zod expect character length, so the byte length is halved.
   */
  nationalChar?: boolean;
  /**
   * Width fixed by the type itself, for types whose precision/scale the catalog
   * does not report (`size: "none"`).
   */
  width?: DecimalWidth;
}

/**
 * Sybase base system type name (lower-cased) -> mapping.
 *
 * Keys are the canonical system type names returned after UDT resolution.
 */
export const SYBASE_TYPE_MAP: Readonly<Record<string, TypeMapping>> = {
  int: { factory: "int", size: "none", value: "number" },
  // 64-bit, up to 9223372036854775807 — 19 digits, well past what a double can
  // hold exactly, so the driver hands it over as a BigInt and writes are capped
  // to what that width keeps.
  bigint: { factory: "bigint", size: "none", value: "bigint", width: { precision: 19, scale: 0 } },
  smallint: { factory: "smallint", size: "none", value: "number" },
  tinyint: { factory: "tinyint", size: "none", value: "number" },

  varchar: { factory: "varchar", size: "length", value: "string" },
  nvarchar: { factory: "nvarchar", size: "length", value: "string", nationalChar: true },
  char: { factory: "char", size: "length", value: "string" },
  nchar: { factory: "nchar", size: "length", value: "string", nationalChar: true },
  text: { factory: "text", size: "none", value: "string" },
  ntext: { factory: "ntext", size: "none", value: "string" },

  datetime: { factory: "datetime", size: "none", value: "date" },
  smalldatetime: { factory: "smalldatetime", size: "none", value: "date" },

  numeric: { factory: "numeric", size: "precision", value: "decimal" },
  decimal: { factory: "numeric", size: "precision", value: "decimal" },

  float: { factory: "float", size: "none", value: "number" },
  real: { factory: "real", size: "none", value: "number" },
  // money is +/-922337203685477.5807 and smallmoney +/-214748.3647, i.e. (19,4)
  // and (10,4). The catalog reports no precision for either, so the widths are
  // supplied here from the type definitions.
  money: { factory: "money", size: "none", value: "decimal", width: { precision: 19, scale: 4 } },
  smallmoney: {
    factory: "smallmoney",
    size: "none",
    value: "decimal",
    width: { precision: 10, scale: 4 }
  },

  bit: { factory: "bit", size: "none", value: "boolean" },

  binary: { factory: "binary", size: "length", value: "buffer" },
  varbinary: { factory: "varbinary", size: "length", value: "buffer" },
  image: { factory: "image", size: "none", value: "buffer" }
} as const;

/**
 * Fallback used when a Sybase type is not in the registry. We render it as a
 * variable-length string so the generated schema still compiles, but emit a
 * warning so unmapped types are not silently misrepresented.
 */
export const FALLBACK_MAPPING: TypeMapping = {
  factory: "varchar",
  size: "length",
  value: "string"
};

/** Resolve a column's type mapping, falling back to `varchar` for unknown types. */
export function resolveMapping(typeName: string): {
  mapping: TypeMapping;
  isFallback: boolean;
} {
  // Use Object.hasOwn so prototype keys (e.g. "constructor", "toString") that
  // could appear as a (malformed) type name never resolve to inherited members.
  if (Object.hasOwn(SYBASE_TYPE_MAP, typeName)) {
    return { mapping: SYBASE_TYPE_MAP[typeName], isFallback: false };
  }
  return { mapping: FALLBACK_MAPPING, isFallback: true };
}

/**
 * Effective character length for a column, halving the catalog byte length for
 * national (Unicode) char types. Never returns less than 1 — a zero/negative
 * catalog length would otherwise emit `{ length: 0 }`, which is not a valid
 * column width.
 */
export function effectiveLength(col: ColumnMeta, mapping: TypeMapping): number {
  const raw = mapping.nationalChar ? Math.floor(col.length / 2) : col.length;
  return raw > 0 ? raw : 1;
}

/**
 * Widest JS type that is still lossless for a fixed-point column.
 *
 * - `int`    — integer that fits a double exactly
 * - `number` — has a fraction, fits a double closely enough to round-trip
 * - `bigint` — integer too wide for a double
 * - `string` — has a fraction and is too wide for a double; no lossless JS
 *              numeric type exists, so the digits are kept as text
 */
export type DecimalRepresentation = "int" | "number" | "bigint" | "string";

/**
 * Integers are exact in a double below 2^53, which works out at 15 decimal
 * digits. The boundary is real, not theoretical: the maximum numeric(16,0),
 * 9999999999999999, reads back as 10000000000000000.
 */
export const MAX_EXACT_DECIMAL_DIGITS = 15;

/**
 * Pick the widest JS numeric type that is lossless for a fixed-point column.
 *
 * This drives what an insert schema will accept. The native driver returns these
 * columns as strings, so a string is always accepted; the question this answers
 * is which *numeric* type may be accepted alongside it without risking silent
 * digit loss:
 *
 * | width                      | representation | why                                                   |
 * | -------------------------- | -------------- | ----------------------------------------------------- |
 * | scale 0, precision <= 15   | `int`          | exact below 2^53                                      |
 * | scale > 0, precision <= 15 | `number`       | not bit-exact (0.1 is stored as 0.1000000000000000055) |
 * |                            |                | but round-trips exactly via `toFixed`                 |
 * | scale 0, precision > 15    | `bigint`       | exact at any width                                    |
 * | scale > 0, precision > 15  | `string`       | no lossless JS numeric type                           |
 *
 * A width the catalog does not report and the type does not fix falls back to
 * `string`, the only representation that cannot lose anything.
 *
 * The decision is made from the declared type alone, never from how large the
 * values in a particular database happen to be — a schema that is only correct
 * while the data stays small is the fragile kind.
 */
export function decimalRepresentation(
  col: ColumnMeta,
  mapping: TypeMapping
): DecimalRepresentation {
  const precision = mapping.width?.precision ?? col.precision ?? 0;
  const scale = mapping.width?.scale ?? col.scale ?? 0;
  if (precision <= 0) {
    return "string";
  }
  if (precision <= MAX_EXACT_DECIMAL_DIGITS) {
    return scale === 0 ? "int" : "number";
  }
  return scale === 0 ? "bigint" : "string";
}
