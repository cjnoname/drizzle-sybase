/**
 * Fetch table / column / index metadata from the Sybase ASE system catalogs.
 *
 * The SQL here intentionally mirrors the battle-tested queries that shipped via
 * the original patch (sysobjects / syscolumns / systypes / syscomments /
 * sysindexes, the UDT resolution sub-select, and the status bit masks). The
 * changes are limited to:
 *   - type safety (typed row shapes instead of `any`),
 *   - a single identifier guard ({@link assertSafeIdentifier}),
 *   - index key columns resolved in one query per index instead of one query
 *     per column (the previous N x M round-trips).
 */

import { escapeString } from "../dialect.js";
import type { ColumnMeta, IndexMeta, IntrospectDb } from "./types.js";

const VALID_SQL_IDENTIFIER = /^[A-Za-z0-9_]+$/;

/**
 * Guard every identifier that is interpolated into catalog SQL. Catalog queries
 * cannot be parameterised (database name, object names and `index_col()`
 * arguments are not bindable), so this allow-list is the single line of defence
 * against injection — applied once, here, at the lowest layer.
 */
export function assertSafeIdentifier(
  value: string | undefined,
  label: string
): asserts value is string {
  if (!value || !VALID_SQL_IDENTIFIER.test(value) || value.length > 128) {
    throw new Error(`Unsafe ${label}: "${value}". Only [A-Za-z0-9_] allowed, max 128 chars.`);
  }
}

// ---------------------------------------------------------------------------
// Status bit masks (syscolumns.status / sysindexes.status)
// ---------------------------------------------------------------------------

const COLUMN_STATUS_NULLABLE = 8;
const COLUMN_STATUS_IDENTITY = 128;
const INDEX_STATUS_UNIQUE = 2;
const INDEX_STATUS_PRIMARY = 2048;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface TableRow extends Record<string, unknown> {
  name: string;
  owner: string | null;
}

export interface FetchedTable {
  name: string;
  owner: string;
}

export async function fetchTables(
  db: IntrospectDb,
  database: string,
  tableFilter?: string[],
  owner?: string
): Promise<FetchedTable[]> {
  assertSafeIdentifier(database, "database");
  if (owner !== undefined) {
    assertSafeIdentifier(owner, "owner");
  }
  tableFilter?.forEach(t => assertSafeIdentifier(t, "table"));

  const ownerFilter = owner ? `AND u.name = ${escapeString(owner)}` : "";
  const tableFilterSql =
    tableFilter && tableFilter.length > 0
      ? `AND o.name IN (${tableFilter.map(t => escapeString(t)).join(", ")})`
      : "";

  const result = await db.executeRaw<TableRow>(
    `SELECT o.name, u.name AS owner
     FROM ${database}..sysobjects o
     LEFT JOIN ${database}..sysusers u ON o.uid = u.uid
     WHERE o.type = 'U'
       AND o.name NOT LIKE 'sys%'
       ${ownerFilter}
       ${tableFilterSql}
     ORDER BY o.name`
  );

  return result.rows.map(row => ({ name: row.name, owner: row.owner ?? "" }));
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

interface ColumnRow extends Record<string, unknown> {
  name: string;
  colid: number;
  type_name: string | null;
  length: number;
  prec: number | null;
  scale: number | null;
  status: number;
}

interface DefaultRow extends Record<string, unknown> {
  col_name: string;
  default_text: string | null;
}

export async function fetchColumns(
  db: IntrospectDb,
  database: string,
  tableName: string
): Promise<ColumnMeta[]> {
  assertSafeIdentifier(database, "database");
  assertSafeIdentifier(tableName, "tableName");

  // Resolve UDTs to base system types via the systypes hierarchy.
  // UDTs have usertype >= 100; resolve to the base type (usertype < 100) by
  // matching on the internal type number and picking MIN(usertype) as the
  // canonical system type.
  const result = await db.executeRaw<ColumnRow>(
    `SELECT
       c.name,
       c.colid,
       CASE
         WHEN t.usertype < 100 THEN t.name
         ELSE (SELECT s.name FROM ${database}..systypes s
               WHERE s.type = t.type AND s.usertype < 100
               AND s.usertype = (SELECT MIN(s2.usertype) FROM ${database}..systypes s2
                                 WHERE s2.type = t.type AND s2.usertype < 100))
       END AS type_name,
       c.length,
       c.prec,
       c.scale,
       c.status
     FROM ${database}..syscolumns c
     JOIN ${database}..systypes t ON c.usertype = t.usertype
     WHERE c.id = OBJECT_ID('${database}..${tableName}')
     ORDER BY c.colid`
  );

  const defaultsResult = await db.executeRaw<DefaultRow>(
    `SELECT
       c.name AS col_name,
       com.text AS default_text
     FROM ${database}..syscolumns c
     JOIN ${database}..syscomments com ON com.id = c.cdefault
     WHERE c.id = OBJECT_ID('${database}..${tableName}')
       AND c.cdefault != 0`
  );

  const defaultsMap = new Map(
    defaultsResult.rows.map(r => [r.col_name, r.default_text?.trim() ?? null])
  );

  return result.rows.map(row => {
    if (!row.type_name) {
      throw new Error(
        `Could not resolve a base system type for column "${row.name}" of table "${tableName}". ` +
          `This usually means an unresolvable user-defined type.`
      );
    }
    return {
      name: row.name,
      colid: row.colid,
      typeName: row.type_name.toLowerCase(),
      length: row.length,
      precision: row.prec,
      scale: row.scale,
      isNullable: (row.status & COLUMN_STATUS_NULLABLE) === COLUMN_STATUS_NULLABLE,
      isIdentity: (row.status & COLUMN_STATUS_IDENTITY) === COLUMN_STATUS_IDENTITY,
      defaultValue: defaultsMap.get(row.name) ?? null
    };
  });
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

interface IndexRow extends Record<string, unknown> {
  index_name: string;
  indid: number;
  status: number;
  keycnt: number;
}

export async function fetchIndexes(
  db: IntrospectDb,
  database: string,
  tableName: string
): Promise<IndexMeta[]> {
  assertSafeIdentifier(database, "database");
  assertSafeIdentifier(tableName, "tableName");

  const result = await db.executeRaw<IndexRow>(
    `SELECT i.name AS index_name, i.indid, i.status, i.keycnt
     FROM ${database}..sysindexes i
     WHERE i.id = OBJECT_ID('${database}..${tableName}')
       AND i.indid > 0
       AND i.indid < 255
       AND i.name NOT LIKE 't%'`
  );

  const indexes: IndexMeta[] = [];

  for (const row of result.rows) {
    const columns = await fetchIndexColumns(db, database, tableName, row.indid, row.keycnt);
    if (columns.length > 0) {
      indexes.push({
        indexName: row.index_name,
        isPrimary: (row.status & INDEX_STATUS_PRIMARY) !== 0,
        isUnique: (row.status & INDEX_STATUS_UNIQUE) !== 0,
        columns
      });
    }
  }

  return indexes;
}

interface IndexColRow extends Record<string, unknown> {
  keyno: number;
  col_name: string | null;
}

/**
 * Resolve every key column of a single index in one round-trip.
 *
 * The original implementation issued one `index_col()` query per column (and
 * re-derived `indid` with a sub-select each time). Here `indid` is already known
 * from `sysindexes`, and all key positions are unioned into one query, so each
 * index costs exactly one round-trip regardless of key count.
 */
async function fetchIndexColumns(
  db: IntrospectDb,
  database: string,
  tableName: string,
  indid: number,
  keycnt: number
): Promise<string[]> {
  if (keycnt <= 0) {
    return [];
  }

  const objectRef = escapeString(`${database}..${tableName}`);
  const selects: string[] = [];
  for (let keyno = 1; keyno <= keycnt; keyno++) {
    selects.push(
      `SELECT ${keyno} AS keyno, index_col(${objectRef}, ${indid}, ${keyno}) AS col_name`
    );
  }

  const result = await db.executeRaw<IndexColRow>(`${selects.join(" UNION ALL ")} ORDER BY keyno`);

  const columns: string[] = [];
  for (const r of result.rows) {
    if (!r.col_name) {
      break;
    }
    columns.push(r.col_name);
  }
  return columns;
}
