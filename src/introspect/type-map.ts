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
export type ValueKind = "number" | "boolean" | "date" | "buffer" | "string";

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
}

/**
 * Sybase base system type name (lower-cased) -> mapping.
 *
 * Keys are the canonical system type names returned after UDT resolution.
 */
export const SYBASE_TYPE_MAP: Readonly<Record<string, TypeMapping>> = {
  int: { factory: "int", size: "none", value: "number" },
  bigint: { factory: "bigint", size: "none", value: "number" },
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

  numeric: { factory: "numeric", size: "precision", value: "number" },
  decimal: { factory: "numeric", size: "precision", value: "number" },

  float: { factory: "float", size: "none", value: "number" },
  real: { factory: "real", size: "none", value: "number" },
  money: { factory: "money", size: "none", value: "number" },
  smallmoney: { factory: "smallmoney", size: "none", value: "number" },

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
