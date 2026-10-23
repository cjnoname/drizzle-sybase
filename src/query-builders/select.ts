/**
 * Sybase SELECT query builder.
 *
 * Generates Sybase-compatible SELECT SQL with support for:
 * - Column selection (specific fields or *)
 * - WHERE conditions (via Drizzle SQL expressions)
 * - ORDER BY
 * - GROUP BY / HAVING
 * - JOINs (inner, left, right — ASE has no FULL OUTER JOIN)
 * - DISTINCT
 * - Pagination via SELECT TOP (Sybase has no LIMIT/OFFSET)
 *
 * ASE has no common table expressions (`WITH`); use a derived table instead.
 *
 * @example
 * ```ts
 * // Basic select
 * const rows = await db.select().from(users).where(eq(users.name, "Alice"));
 *
 * // With pagination
 * const page2 = await db.select().from(users).orderBy(users.id).limit(10).offset(10);
 *
 * // With join
 * const result = await db.select()
 *   .from(users)
 *   .leftJoin(orders, eq(users.id, orders.userId))
 *   .where(eq(users.active, true));
 * ```
 */
import type { SQL } from "drizzle-orm";

import { escapeName, escapeTableName, type SybaseDialect } from "../dialect.js";
import type {
  SybaseConnectionSession,
  SybaseSession,
  SybaseTransactionSession
} from "../session.js";
import type { AnySybaseTable } from "../table.js";
import type {
  InitialSelectState,
  JoinGuard,
  SybaseSelectFields,
  SybaseSelectResult,
  SybaseSelectState,
  WithFrom,
  WithJoin,
  WithNamedSource
} from "./select-types.js";

const ColumnsSymbol = Symbol.for("drizzle:Columns");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SybaseSelectField {
  expression: string;
  alias?: string;
}

/** ASE has no FULL OUTER JOIN. */
export interface SybaseSelectJoin {
  type: "inner" | "left" | "right";
  table: string;
  on: string;
}

export interface SybaseSelectConfig {
  fields: SybaseSelectField[];
  table?: string;
  joins?: SybaseSelectJoin[];
  where?: string;
  orderBy?: string[];
  groupBy?: string[];
  having?: string;
  distinct?: boolean;
  limit?: number;
  offset?: number;
  /** Rows to fetch, rendered as `SELECT TOP n`: `offset + limit` when a limit is set. */
  top?: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Largest value `TOP` takes (a 32-bit int). */
const MAX_ROWCOUNT = 2_147_483_647;

/**
 * Validate a limit/offset. They are inlined into `TOP`, so anything
 * that is not a plain integer would be a syntax error at best and injected SQL
 * at worst (for callers outside TypeScript).
 */
const assertRowCount = (name: "limit" | "offset", count: number): number => {
  if (!Number.isInteger(count) || count < 0 || count > MAX_ROWCOUNT) {
    throw new RangeError(
      `${name}() expects an integer between 0 and ${MAX_ROWCOUNT}, got ${String(count)}`
    );
  }
  return count;
};

export class SybaseSelectBuilder<
  S extends SybaseSelectState = InitialSelectState<SybaseSelectFields | undefined>
> {
  private config: SybaseSelectConfig;
  /** No fields were given: select every column of the source tables. */
  private readonly implicitFields: boolean;
  /** Table objects in FROM / JOIN order, used to expand implicit fields. */
  private readonly sources: any[] = [];
  /** A source was given by name, so its columns are unknown. */
  private hasNamedSource = false;

  constructor(
    private readonly dialect: SybaseDialect,
    private readonly session: SybaseSession | SybaseTransactionSession | SybaseConnectionSession,
    fields?: SybaseSelectField[]
  ) {
    this.implicitFields = fields === undefined;
    this.config = {
      fields: fields ?? [{ expression: "*" }]
    };
  }

  /**
   * Select from a table. A table given by name (e.g. a temporary table) is
   * selected as-is: its columns are unknown, so rows are untyped.
   */
  from<T extends AnySybaseTable>(table: T): SybaseSelectBuilder<WithFrom<S, T>>;
  from(table: string): SybaseSelectBuilder<WithNamedSource<S>>;
  from(table: AnySybaseTable | string): unknown {
    this.config.table = this.addSource(table);
    return this;
  }

  /** `undefined` (as `and()` of no conditions returns) means no condition, as in drizzle. */
  where(condition: SQL | undefined): this {
    this.config.where = condition ? this.dialect.sqlToQuery(condition) : undefined;
    return this;
  }

  orderBy(...columns: any[]): this {
    this.config.orderBy = this.resolveColumns(columns);
    return this;
  }

  groupBy(...columns: any[]): this {
    this.config.groupBy = this.resolveColumns(columns);
    return this;
  }

  having(condition: SQL | undefined): this {
    this.config.having = condition ? this.dialect.sqlToQuery(condition) : undefined;
    return this;
  }

  // The typed overload is last: TypeScript reports the last overload's error,
  // which for a clashing join is the one that names the clash.
  innerJoin(table: string, on: SQL): SybaseSelectBuilder<WithNamedSource<S, "inner">>;
  innerJoin<T extends AnySybaseTable>(
    table: T & JoinGuard<S, T>,
    on: SQL
  ): SybaseSelectBuilder<WithJoin<S, T, "inner">>;
  innerJoin(table: AnySybaseTable | string, on: SQL): unknown {
    return this.addJoin("inner", table, on);
  }

  /** The joined table's columns come back `null` where nothing matched. */
  // The typed overload is last: TypeScript reports the last overload's error,
  // which for a clashing join is the one that names the clash.
  leftJoin(table: string, on: SQL): SybaseSelectBuilder<WithNamedSource<S, "left">>;
  leftJoin<T extends AnySybaseTable>(
    table: T & JoinGuard<S, T>,
    on: SQL
  ): SybaseSelectBuilder<WithJoin<S, T, "left">>;
  leftJoin(table: AnySybaseTable | string, on: SQL): unknown {
    return this.addJoin("left", table, on);
  }

  /** Every earlier table's columns come back `null` where nothing matched. */
  // The typed overload is last: TypeScript reports the last overload's error,
  // which for a clashing join is the one that names the clash.
  rightJoin(table: string, on: SQL): SybaseSelectBuilder<WithNamedSource<S, "right">>;
  rightJoin<T extends AnySybaseTable>(
    table: T & JoinGuard<S, T>,
    on: SQL
  ): SybaseSelectBuilder<WithJoin<S, T, "right">>;
  rightJoin(table: AnySybaseTable | string, on: SQL): unknown {
    return this.addJoin("right", table, on);
  }

  distinct(): this {
    this.config.distinct = true;
    return this;
  }

  /**
   * Set max rows to return, as `SELECT TOP n` (ASE has no LIMIT).
   *
   * - `limit(0)` returns zero rows
   * - Anything but a non-negative integer throws: the value is inlined into
   *   the batch
   */
  limit(count: number): this {
    this.config.limit = assertRowCount("limit", count);
    return this;
  }

  /**
   * Set offset for pagination.
   *
   * **Implementation:** Sybase ASE does not support OFFSET natively.
   * This is implemented by fetching `offset + limit` rows with `TOP`,
   * then slicing off the first `offset` rows in application code.
   *
   * For best performance with large offsets, consider cursor-based pagination
   * using WHERE clauses on indexed columns instead.
   *
   * ORDER BY is required for deterministic results with offset.
   */
  offset(count: number): this {
    this.config.offset = assertRowCount("offset", count);
    return this;
  }

  /**
   * Get the generated SQL string (for testing/debugging).
   */
  toSQL(): string {
    return this.buildSql();
  }

  /**
   * Execute the query and return typed results.
   */
  async execute(): Promise<SybaseSelectResult<S>[]> {
    // Safety: offset without limit would fetch entire table into memory then slice.
    if (
      this.config.offset !== undefined &&
      this.config.offset > 0 &&
      this.config.limit === undefined
    ) {
      throw new Error(
        "offset() requires limit() to be set. " +
          "Without a limit, the entire table would be fetched into memory before slicing. " +
          "Use cursor-based pagination (WHERE id > ?) for large offsets."
      );
    }

    // limit(0) means no rows. Not left to the generated `where 1=0`: an
    // aggregate without GROUP BY still returns one row over an empty input
    // (`count(*)` gives `[{ n: 0 }]`).
    if (this.config.limit === 0) {
      return [];
    }

    const rawSql = this.buildSql();
    const maxRows = this.getMaxRowsHint();
    const result = await this.session.execute(rawSql, maxRows ? { maxRows } : undefined);
    // The rows are shaped by the field list this builder generated, which is
    // what the result type describes.
    const rows = result.rows as SybaseSelectResult<S>[];

    // If offset is set, skip the first N rows in application code
    // (Sybase ASE has no native OFFSET support)
    if (this.config.offset !== undefined && this.config.offset > 0) {
      return rows.slice(this.config.offset);
    }
    return rows;
  }

  /**
   * Alias for execute() — enables `await db.select()...` pattern.
   */
  then<TResult1 = SybaseSelectResult<S>[], TResult2 = never>(
    onfulfilled?: ((value: SybaseSelectResult<S>[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private resolveColumns(columns: any[]): string[] {
    return columns.map(col => this.dialect.renderExpression(col, "reference"));
  }

  private addJoin(type: SybaseSelectJoin["type"], table: any, on: SQL): this {
    if (!this.config.joins) {
      this.config.joins = [];
    }

    const tableName = this.addSource(table);
    const onStr = this.dialect.sqlToQuery(on);
    this.config.joins.push({ type, table: tableName, on: onStr });
    return this;
  }

  /** Record a FROM / JOIN source and return its escaped reference. */
  private addSource(table: any): string {
    if (typeof table === "string") {
      this.hasNamedSource = true;
      return escapeName(table);
    }
    this.sources.push(table);
    return escapeTableName(table);
  }

  /**
   * Fields for a select with none given: every column of every source table,
   * aliased to its property name — the keys the table definition and the
   * generated schemas use, rather than the database column names `select *`
   * would return.
   *
   * Falls back to `*` when a source was given by name, since its columns are
   * unknown. Throws when two sources share a property name: a flat row cannot
   * hold both, and keeping one silently would lose data.
   */
  private implicitFieldList(): SybaseSelectField[] {
    if (this.hasNamedSource || this.sources.length === 0) {
      return [{ expression: "*" }];
    }
    const fields: SybaseSelectField[] = [];
    const owners = new Map<string, string>();
    for (const table of this.sources) {
      const tableRef = escapeTableName(table);
      for (const [property, col] of Object.entries<any>(table[ColumnsSymbol] ?? {})) {
        const previous = owners.get(property);
        if (previous !== undefined) {
          throw new Error(
            `Cannot select every column: property "${property}" exists in both ${previous} and ` +
              `${tableRef}. Pass the fields explicitly, e.g. db.select({ ... }).`
          );
        }
        owners.set(property, tableRef);
        fields.push({ expression: `${tableRef}.${escapeName(col.name)}`, alias: property });
      }
    }
    return fields;
  }

  private buildSql(): string {
    const config: SybaseSelectConfig = this.implicitFields
      ? { ...this.config, fields: this.implicitFieldList() }
      : this.config;
    // `SELECT TOP n` rather than `SET ROWCOUNT n`: TOP is part of the
    // statement, so it changes no session state that could outlive it (a
    // ROWCOUNT left set by a batch that stopped early would truncate the next
    // pool user's queries). `TOP 0` returns no rows, as limit(0) means.
    if (config.limit === undefined) {
      return this.dialect.buildSelectQuery(config);
    }
    const top = (config.offset ?? 0) + config.limit;
    if (top > MAX_ROWCOUNT) {
      throw new RangeError(`offset() + limit() must not exceed ${MAX_ROWCOUNT}, got ${top}`);
    }
    return this.dialect.buildSelectQuery({ ...config, top });
  }

  /**
   * Get a hint for the native maxRows parameter to limit memory usage.
   * When offset+limit is known, we can tell the native layer the max rows expected.
   */
  private getMaxRowsHint(): number | undefined {
    if (this.config.limit !== undefined && this.config.offset !== undefined) {
      return this.config.offset + this.config.limit;
    }
    if (this.config.limit !== undefined) {
      return this.config.limit;
    }
    return undefined;
  }
}
