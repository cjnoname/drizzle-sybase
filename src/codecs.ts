/**
 * Codecs for Sybase types that need a CONVERT around inlined parameters.
 *
 * ASE refuses to compare or assign a quoted literal against an exact numeric
 * type:
 *
 *     Msg 257: Implicit conversion from datatype 'VARCHAR' to 'MONEY' is not
 *              allowed. Use the CONVERT function to run this query.
 *
 * These are exactly the types the native driver returns as strings (see
 * `binding.c`: money and decimal are handed over as text so no digits are
 * lost), so without a CONVERT they could be read but never written back or
 * filtered on — `money` alone needs 19 significant digits and a JS double
 * carries about 15.
 *
 * CONVERT parses the digits server-side at full precision, so no JS double is
 * involved and nothing is lost: money 922337203685477.5807, numeric(19,4)
 * 999999999999999.9999 and numeric(20,0) 99999999999999999999 all round-trip
 * exactly.
 *
 * ASE would equally accept the digits emitted bare, unquoted, and since only
 * values matching {@link QUOTED_DECIMAL_LITERAL} are ever rewritten that would
 * be no less safe against injection. CONVERT is used instead because it keeps
 * the *target's* width in the statement: a value too precise for the column is
 * then a hard error rather than something ASE quietly rounds on the way in. See
 * {@link castExactNumericLiteral} for how that guard is applied.
 */

import type { Codecs } from "drizzle-orm/codecs";

/** Type keys of the codecs below; set as `codec` on the matching columns. */
export const EXACT_NUMERIC_TYPES = ["money", "smallmoney", "bigint", "numeric", "decimal"] as const;

/**
 * Column shape the helpers here rely on. Satisfied by `SybaseColumn` and by
 * drizzle-orm's `Column`, both of which always expose `getSQLType()`.
 */
export interface SqlTypedColumn {
  getSQLType?: () => unknown;
}

/** Declared SQL type of a column, or `""` for anything that cannot report one. */
const columnSqlType = (col: SqlTypedColumn): string => {
  const sqlType = typeof col.getSQLType === "function" ? col.getSQLType() : undefined;
  return typeof sqlType === "string" ? sqlType.trim() : "";
};

/** Scales fixed by the type itself, for types that declare no precision/scale. */
const FIXED_SCALES: Readonly<Record<string, number>> = {
  money: 4,
  smallmoney: 4,
  bigint: 0
};

/**
 * `numeric` / `decimal` with a declared width, capturing the scale.
 *
 * A bare `numeric`/`decimal` deliberately does not match: ASE would default it
 * to (18,0) and silently round the fraction away, so those are left to fail
 * loudly rather than lose digits. Precision must be non-zero, since
 * `convert(numeric(0), ...)` is not valid SQL.
 */
const SIZED_DECIMAL = /^(?:numeric|decimal)\s*\(\s*[1-9]\d*\s*(?:,\s*(\d+)\s*)?\)$/i;

/**
 * Digits after the point the target keeps, or `undefined` when the type is not
 * an exact numeric that needs converting. This is the single gate: a type is
 * convertible exactly when it has a known scale.
 */
const declaredScale = (sqlType: string): number | undefined => {
  const fixed = FIXED_SCALES[sqlType.toLowerCase()];
  if (fixed !== undefined) {
    return fixed;
  }
  const match = SIZED_DECIMAL.exec(sqlType);
  // ASE defaults an undeclared scale to 0.
  return match ? Number(match[1] ?? 0) : undefined;
};

/**
 * A decimal literal as it appears in the statement, i.e. after `escapeString`.
 *
 * Matching on the quoted form is what makes this safe to apply to arbitrary
 * serialized values: bare numbers, `NULL`, hex blobs and date literals all fail
 * it, and so does any string that is not purely digits — including one carrying
 * a quote, which could otherwise reach the parser through CONVERT's argument.
 */
const QUOTED_DECIMAL_LITERAL = /^'[+-]?(?:\d+(?:\.\d*)?|\.\d+)'$/;

/** Significant digits after the point; trailing zeros carry no value. */
const fractionDigits = (literal: string): number => {
  const point = literal.indexOf(".");
  if (point < 0) {
    return 0;
  }
  return literal.slice(point + 1).replace(/0+$/, "").length;
};

/**
 * Wrap an already-escaped literal in CONVERT when the column requires it.
 *
 * Returns the literal untouched when the target is not an exact numeric with a
 * known scale, when the literal is not a plain quoted decimal, or when it
 * carries more fraction digits than the target keeps. That last guard matters:
 * `'1.5'` against `bigint` is a hard error today (Msg 257), and wrapping it
 * would turn that into a silent round to 2. Refusing to convert keeps the loud
 * failure, which is the whole point of this module.
 */
export const castExactNumericLiteral = (literal: string, col: SqlTypedColumn): string => {
  if (!QUOTED_DECIMAL_LITERAL.test(literal)) {
    return literal;
  }
  const sqlType = columnSqlType(col);
  const scale = declaredScale(sqlType);
  if (scale === undefined || fractionDigits(literal.slice(1, -1)) > scale) {
    return literal;
  }
  return `convert(${sqlType}, ${literal})`;
};

/**
 * Applied by drizzle-orm to inlined parameters (WHERE, JOIN ... ON, HAVING),
 * which do not pass through `SybaseDialect#serializeColumnValue`.
 */
export const SYBASE_CODECS: Codecs = Object.fromEntries(
  EXACT_NUMERIC_TYPES.map(type => [
    type,
    {
      castParam: (name: string, column: unknown) =>
        castExactNumericLiteral(name, column as SqlTypedColumn)
    }
  ])
);
