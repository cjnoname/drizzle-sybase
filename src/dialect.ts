/**
 * Sybase ASE SQL dialect — generates Sybase-compatible SQL from Drizzle's AST.
 *
 * Key differences from MSSQL:
 * - No OFFSET/FETCH → SELECT TOP (offset + limit), the offset skipped client-side.
 *   TOP rather than SET ROWCOUNT: it changes no session state.
 * - No OUTPUT/RETURNING → use SELECT @@identity after INSERT for identity
 * - Identifiers quoted with [] (same as MSSQL)
 * - Parameters inlined (db-lib supports params, but inline is simpler for now)
 * - String concatenation with +
 */
import { Buffer } from "node:buffer";

import type { SQL } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { CodecsCollection, refineCodecs, type Codecs } from "drizzle-orm/codecs";

import { castExactNumericLiteral, SYBASE_CODECS } from "./codecs.js";
import { OriginalColumn } from "./columns/index.js";
import { formatSybaseDateTime, resolveTimeZone } from "./datetime.js";
import type { SybaseSelectConfig } from "./query-builders/select.js";

// ---------------------------------------------------------------------------
// SQL escaping helpers
// ---------------------------------------------------------------------------

/**
 * Escape a Sybase identifier with brackets.
 *
 * Temporary table names (`#name`) are the exception: ASE rejects a quoted
 * identifier that starts with `#` (Msg 11717), so they are emitted as plain
 * identifiers — which requires them to be valid ones.
 */
export const escapeName = (name: string): string => {
  if (name.startsWith("#")) {
    if (!/^#[A-Za-z0-9_@#$]+$/.test(name)) {
      throw new Error(
        `Invalid temporary table name ${JSON.stringify(name)}: ASE cannot quote a name ` +
          "starting with '#', so it may contain only letters, digits, _, @, # and $"
      );
    }
    return name;
  }
  return `[${name.replace(/\]/g, "]]")}]`;
};

const TableSchemaSymbol = Symbol.for("drizzle:Schema");

/**
 * Escaped reference to a table object: `[owner].[name]` when it was defined
 * with an owner, `[name]` otherwise. The same form drizzle-orm uses when it
 * renders the table's columns, so FROM and WHERE always agree.
 */
export const escapeTableName = (table: any): string => {
  const owner: string | undefined = table[TableSchemaSymbol];
  const name = escapeName(getTableName(table));
  return owner === undefined ? name : `${escapeName(owner)}.${name}`;
};

/** A character a Latin-1 SQL text cannot carry (see {@link escapeString}). */
// eslint-disable-next-line no-control-regex
const NON_LATIN1 = /[^\u0000-\u00ff]/;

/**
 * Escape a string value for inline SQL (single-quote wrapping + escaping).
 *
 * Handles:
 * - Single quotes (doubled)
 * - Null bytes (removed — Sybase db-lib cannot handle \0 in strings)
 * - Backslashes (kept as-is — Sybase does not use C-style escaping)
 * - Characters past U+00FF: the string is written as a `U&'...'` literal with
 *   those characters as `\XXXX` / `\+XXXXXX` escapes. A server whose character
 *   set is iso_1 cannot take them in the SQL text itself, and would otherwise
 *   receive each as several unrelated characters. The literal is unichar: it
 *   stores exactly into unichar/univarchar/unitext, and a char/varchar column
 *   that cannot hold the character makes the server refuse it (Msg 2402).
 */
export const escapeString = (str: string): string => {
  // Remove null bytes which can cause truncation in db-lib
  // eslint-disable-next-line no-control-regex
  const sanitized = str.replace(/\u0000/g, "");
  if (!NON_LATIN1.test(sanitized)) {
    // Double single quotes for SQL escaping
    return `'${sanitized.replace(/'/g, "''")}'`;
  }
  let body = "";
  for (const char of sanitized) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new Error(
        `Cannot send a string holding an unpaired surrogate (U+${code.toString(16).toUpperCase()}) ` +
          "to Sybase: it is not a character."
      );
    }
    if (code > 0xffff) {
      body += `\\+${code.toString(16).padStart(6, "0")}`;
    } else if (code > 0xff) {
      body += `\\${code.toString(16).padStart(4, "0")}`;
    } else if (char === "\\") {
      // The escape character of a U& literal.
      body += "\\\\";
    } else if (char === "'") {
      body += "''";
    } else {
      body += char;
    }
  }
  return `U&'${body}'`;
};

/**
 * Serialize a JS value to inline SQL literal.
 *
 * Handles all JavaScript types and edge cases:
 * - null/undefined → NULL
 * - numbers (including NaN/Infinity checks)
 * - booleans → 1/0
 * - Date → Sybase-compatible datetime string, in `timeZone` (default UTC)
 * - Buffer → hex literal (0x...)
 * - bigint → numeric string
 * - Arrays → throws (use individual values)
 * - Strings → escaped string literal
 */
export const serializeValue = (value: unknown, timeZone?: string): string => {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialize non-finite number to SQL: ${value}`);
    }
    // `String()` switches to exponential notation at 1e21, and ASE reads that as
    // a float — so an integer that a wide `numeric` could hold exactly would be
    // rounded to a double's precision on the way in. BigInt renders every digit.
    if (Number.isInteger(value) && Math.abs(value) >= 1e21) {
      return BigInt(value).toString();
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("Cannot serialize invalid Date to SQL");
    }
    // ASE stores a naive wall clock, so the instant has to be rendered in the
    // server's zone. Without one configured this is UTC, which is byte for byte
    // what `toISOString()` produced before `timeZone` existed. ASE does NOT
    // accept the ISO 8601 'T' separator — hence the space.
    return `'${formatSybaseDateTime(value, timeZone)}'`;
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString("hex")}`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    throw new Error(`Cannot serialize ${typeof value} to SQL`);
  }
  if (Array.isArray(value)) {
    throw new Error("Cannot serialize Array to SQL. Use individual values instead.");
  }
  if (typeof value === "object") {
    throw new Error(
      `Cannot serialize object to SQL. Got: ${Object.prototype.toString.call(value)}`
    );
  }
  return escapeString(String(value));
};

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

export interface SybaseDialectConfig {
  /** Extra or overriding codecs, merged over the built-in Sybase set. */
  codecs?: Codecs;
  /** IANA zone the server keeps its clocks in. Default: UTC. */
  timeZone?: string;
}

export class SybaseDialect {
  /**
   * Applied to inlined parameters by drizzle-orm. This is what covers WHERE,
   * JOIN ... ON and HAVING, which build their SQL from drizzle's own chunks
   * rather than through {@link SybaseDialect.serializeColumnValue}.
   */
  readonly codecs: CodecsCollection;

  /** Zone used to render `Date` values as ASE wall clocks. */
  readonly timeZone: string;

  constructor(config?: SybaseDialectConfig) {
    this.codecs = new CodecsCollection(
      type => type,
      config?.codecs ? refineCodecs(SYBASE_CODECS, config.codecs) : SYBASE_CODECS
    );
    // Validated here so a typo fails at setup rather than from inside the first
    // statement that happens to carry a Date.
    this.timeZone = resolveTimeZone(config?.timeZone);
  }

  /**
   * Convert a Drizzle SQL object to a raw SQL string for Sybase.
   * All parameters are inlined.
   */
  sqlToQuery(sqlObj: SQL): string {
    const { sql: sqlString } = sqlObj.toQuery({
      escapeName,
      escapeParam: (_index: number, value: unknown) => serializeValue(value, this.timeZone),
      escapeString,
      codecs: this.codecs
    });
    return sqlString;
  }

  /**
   * Serialize a column value to inline SQL.
   * Handles SQL expressions (getSQL/toQuery), mapToDriverValue, and raw values.
   *
   * A decimal string bound to `money`, `smallmoney` or a sized
   * `numeric`/`decimal` is wrapped in CONVERT rather than emitted as a plain
   * quoted literal, because ASE refuses the implicit conversion — see
   * `./codecs.ts` for the full reasoning. The same wrapping reaches WHERE and
   * friends through {@link SybaseDialect.codecs}.
   */
  serializeColumnValue(value: unknown, col: any): string {
    if (value && typeof value === "object" && "getSQL" in value) {
      return this.sqlToQuery((value as any).getSQL());
    }
    if (value && typeof value === "object" && "toQuery" in value) {
      return this.sqlToQuery(value as SQL);
    }

    let driverValue = value;
    if (col.mapToDriverValue && value !== null && value !== undefined) {
      driverValue = col.mapToDriverValue(value);
    }

    // `serializeValue` renders a string as `escapeString(value)`, so routing
    // strings through the cast keeps that path identical for every type that
    // needs no CONVERT — the cast returns the literal untouched.
    if (typeof driverValue === "string") {
      return castExactNumericLiteral(escapeString(driverValue), col);
    }

    return serializeValue(driverValue, this.timeZone);
  }

  /**
   * SQL for anything the query builders accept as a column: a table column,
   * an aliased column (`col.as(...)`), a SQL expression or a raw string.
   *
   * `use` decides the one difference between the places they appear:
   * - `"field"` — a select field. An aliased column selects the column it
   *   aliases (the field's key names the result). Returns `undefined` for a
   *   value it cannot render, so the caller can name the offending field.
   * - `"reference"` — ORDER BY / GROUP BY. An aliased column refers to its
   *   alias, as drizzle renders one; anything else falls back to its name or
   *   text (e.g. `orderBy(1)` for the first column).
   */
  renderExpression(value: unknown, use: "field"): string | undefined;
  renderExpression(value: unknown, use: "reference"): string;
  renderExpression(value: unknown, use: "field" | "reference"): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    const v = value as any;
    if (v && v.isAlias) {
      if (use === "reference") {
        return escapeName(v.name);
      }
      if (typeof v[OriginalColumn] === "function") {
        const column = v[OriginalColumn]();
        return `${escapeTableName(column.table)}.${escapeName(column.name)}`;
      }
    }
    // A column (name + table) before getSQL: its getSQL() is a minimal
    // wrapper, not a full SQL object to render.
    if (v && v.name && v.table) {
      return `${escapeTableName(v.table)}.${escapeName(v.name)}`;
    }
    if (v && typeof v.getSQL === "function") {
      return this.sqlToQuery(v.getSQL());
    }
    if (v && typeof v.toQuery === "function") {
      return this.sqlToQuery(v as SQL);
    }
    if (use === "field") {
      return undefined;
    }
    return v && v.name ? escapeName(v.name) : String(value);
  }

  /**
   * Build a SELECT SQL string from config.
   */
  buildSelectQuery(config: SybaseSelectConfig): string {
    const parts: string[] = [];

    // SELECT [DISTINCT] [TOP n] — ASE requires DISTINCT before TOP.
    let selectClause = "select";
    if (config.distinct) {
      selectClause += " distinct";
    }
    if (config.top !== undefined) {
      selectClause += ` top ${config.top}`;
    }

    // Fields
    const fieldsSql = config.fields
      .map(f => {
        if (f.alias && f.expression !== f.alias) {
          return `${f.expression} as ${escapeName(f.alias)}`;
        }
        return f.expression;
      })
      .join(", ");

    parts.push(`${selectClause} ${fieldsSql}`);

    // FROM
    if (config.table) {
      parts.push(`from ${config.table}`);
    }

    // JOINs
    if (config.joins && config.joins.length > 0) {
      for (const join of config.joins) {
        parts.push(`${join.type} join ${join.table} on ${join.on}`);
      }
    }

    // WHERE
    if (config.where) {
      parts.push(`where ${config.where}`);
    }

    // GROUP BY
    if (config.groupBy && config.groupBy.length > 0) {
      parts.push(`group by ${config.groupBy.join(", ")}`);
    }

    // HAVING
    if (config.having) {
      parts.push(`having ${config.having}`);
    }

    // ORDER BY
    if (config.orderBy && config.orderBy.length > 0) {
      parts.push(`order by ${config.orderBy.join(", ")}`);
    }

    return parts.join(" ");
  }
}
