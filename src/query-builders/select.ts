/**
 * Sybase SELECT query builder.
 *
 * Generates Sybase-compatible SELECT SQL with support for:
 * - Column selection (specific fields or *)
 * - WHERE conditions (via Drizzle SQL expressions)
 * - ORDER BY
 * - GROUP BY / HAVING
 * - JOINs (inner, left, right, full)
 * - DISTINCT
 * - Pagination via SET ROWCOUNT (Sybase has no LIMIT/OFFSET)
 * - CTE (WITH)
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

import { escapeName, getTable, type SybaseDialect } from "../dialect.js";
import type { SybaseSession, SybaseTransactionSession } from "../session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SybaseSelectField {
  expression: string;
  alias?: string;
}

export interface SybaseSelectJoin {
  type: "inner" | "left" | "right" | "full";
  table: string;
  on: string;
}

export interface SybaseSelectWithCTE {
  alias: string;
  sql: string;
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
  withList?: SybaseSelectWithCTE[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SybaseSelectBuilder<T extends Record<string, unknown> = Record<string, unknown>> {
  private config: SybaseSelectConfig;

  constructor(
    private readonly dialect: SybaseDialect,
    private readonly session: SybaseSession | SybaseTransactionSession,
    fields?: SybaseSelectField[]
  ) {
    this.config = {
      fields: fields ?? [{ expression: "*" }]
    };
  }

  /**
   * Add a Common Table Expression (CTE) to the query.
   *
   * @example
   * ```ts
   * const result = await db.select()
   *   .with("active_users", sql`select * from [users] where active = 1`)
   *   .from("active_users");
   * ```
   */
  with(alias: string, query: SQL | string): this {
    if (!this.config.withList) {
      this.config.withList = [];
    }
    const sqlStr = typeof query === "string" ? query : this.dialect.sqlToQuery(query);
    this.config.withList.push({ alias, sql: sqlStr });
    return this;
  }

  from(table: any): this {
    if (typeof table === "string") {
      this.config.table = escapeName(table);
    } else {
      this.config.table = escapeName(getTable(table));
    }
    return this;
  }

  where(condition: SQL): this {
    this.config.where = this.dialect.sqlToQuery(condition);
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

  having(condition: SQL): this {
    this.config.having = this.dialect.sqlToQuery(condition);
    return this;
  }

  innerJoin(table: any, on: SQL): this {
    return this.addJoin("inner", table, on);
  }

  leftJoin(table: any, on: SQL): this {
    return this.addJoin("left", table, on);
  }

  rightJoin(table: any, on: SQL): this {
    return this.addJoin("right", table, on);
  }

  fullJoin(table: any, on: SQL): this {
    return this.addJoin("full", table, on);
  }

  distinct(): this {
    this.config.distinct = true;
    return this;
  }

  /**
   * Set max rows to return. Sybase uses SET ROWCOUNT instead of LIMIT.
   *
   * - `limit(0)` returns zero rows (SET ROWCOUNT 0 before query, then reset)
   * - Negative values are ignored
   */
  limit(count: number): this {
    if (count < 0) {
      return this;
    }
    this.config.limit = count;
    return this;
  }

  /**
   * Set offset for pagination.
   *
   * **Implementation:** Sybase ASE does not support OFFSET natively.
   * This is implemented by fetching `offset + limit` rows via SET ROWCOUNT,
   * then slicing off the first `offset` rows in application code.
   *
   * For best performance with large offsets, consider cursor-based pagination
   * using WHERE clauses on indexed columns instead.
   *
   * ORDER BY is required for deterministic results with offset.
   */
  offset(count: number): this {
    if (count < 0) {
      return this;
    }
    this.config.offset = count;
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
  async execute(): Promise<T[]> {
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

    const rawSql = this.buildSql();
    const maxRows = this.getMaxRowsHint();
    const result = await this.session.execute<T>(rawSql, maxRows ? { maxRows } : undefined);

    // If offset is set, skip the first N rows in application code
    // (Sybase ASE has no native OFFSET support)
    if (this.config.offset !== undefined && this.config.offset > 0) {
      return result.rows.slice(this.config.offset);
    }
    return result.rows;
  }

  /**
   * Alias for execute() — enables `await db.select()...` pattern.
   */
  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private resolveColumns(columns: any[]): string[] {
    return columns.map(col => {
      if (typeof col === "string") {
        return col;
      }
      if (col && typeof col.getSQL === "function") {
        return this.dialect.sqlToQuery(col.getSQL());
      }
      if (col && typeof col.toQuery === "function") {
        return this.dialect.sqlToQuery(col);
      }
      if (col && col.name) {
        return escapeName(col.name);
      }
      return String(col);
    });
  }

  private addJoin(type: "inner" | "left" | "right" | "full", table: any, on: SQL): this {
    if (!this.config.joins) {
      this.config.joins = [];
    }

    let tableName: string;
    if (typeof table === "string") {
      tableName = escapeName(table);
    } else {
      tableName = escapeName(getTable(table));
    }

    const onStr = this.dialect.sqlToQuery(on);
    this.config.joins.push({ type, table: tableName, on: onStr });
    return this;
  }

  private buildSql(): string {
    // Special case: limit(0) means return no rows
    // In Sybase, SET ROWCOUNT 0 means "no limit", so we add WHERE 1=0
    if (this.config.limit === 0) {
      const configWithFalseWhere: SybaseSelectConfig = {
        ...this.config,
        where: this.config.where ? `1=0 and (${this.config.where})` : "1=0"
      };
      return this.dialect.buildSelectQuery(configWithFalseWhere);
    }

    const paginationParts: string[] = [];
    if (this.config.limit !== undefined && this.config.offset !== undefined) {
      paginationParts.push(`SET ROWCOUNT ${this.config.offset + this.config.limit}`);
    } else if (this.config.limit !== undefined) {
      paginationParts.push(`SET ROWCOUNT ${this.config.limit}`);
    }

    const selectSql = this.dialect.buildSelectQuery(this.config);

    if (paginationParts.length > 0) {
      return `${paginationParts.join("\n")}\n${selectSql}\nSET ROWCOUNT 0`;
    }

    return selectSql;
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
