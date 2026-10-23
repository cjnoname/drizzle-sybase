/**
 * Sybase DELETE query builder.
 *
 * Generates DELETE FROM...WHERE SQL for Sybase ASE.
 *
 * @example
 * ```ts
 * // Delete specific rows
 * await db.delete(users).where(eq(users.id, 1));
 *
 * // Delete all rows (use with caution!)
 * await db.delete(users);
 * ```
 */
import type { SQL } from "drizzle-orm";

import { escapeTableName, type SybaseDialect } from "../dialect.js";
import type {
  SybaseConnectionSession,
  SybaseSession,
  SybaseTransactionSession
} from "../session.js";
import type { AnySybaseTable } from "../table.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SybaseDeleteResult {
  rowCount: number;
  affectedRows: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SybaseDeleteBuilder<TTable extends AnySybaseTable = AnySybaseTable> {
  private whereCondition?: string;

  constructor(
    private readonly table: TTable,
    private readonly dialect: SybaseDialect,
    private readonly session: SybaseSession | SybaseTransactionSession | SybaseConnectionSession
  ) {}

  /** `undefined` (as `and()` of no conditions returns) means no condition, as in drizzle. */
  where(condition: SQL | undefined): this {
    this.whereCondition = condition ? this.dialect.sqlToQuery(condition) : undefined;
    return this;
  }

  toSQL(): string {
    return this.buildSql();
  }

  async execute(): Promise<SybaseDeleteResult> {
    const rawSql = this.buildSql();
    const result = await this.session.execute(rawSql);
    return { rowCount: result.rowCount, affectedRows: result.affectedRows };
  }

  then<TResult1 = SybaseDeleteResult, TResult2 = never>(
    onfulfilled?: ((value: SybaseDeleteResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private buildSql(): string {
    const tableName = escapeTableName(this.table);
    let query = `delete from ${tableName}`;
    if (this.whereCondition) {
      query += ` where ${this.whereCondition}`;
    }
    return query;
  }
}
