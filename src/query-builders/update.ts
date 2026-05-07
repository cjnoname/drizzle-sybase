/**
 * Sybase UPDATE query builder.
 *
 * Generates UPDATE...SET...WHERE SQL for Sybase ASE.
 * Supports `onUpdateFn` columns (e.g., auto-update timestamps).
 *
 * @example
 * ```ts
 * await db.update(users)
 *   .set({ name: "Robert", email: "robert@example.com" })
 *   .where(eq(users.id, 1));
 * ```
 */
import type { SQL } from "drizzle-orm";

import { escapeName, getTable, getTableColumns, type SybaseDialect } from "../dialect.js";
import type { SybaseSession, SybaseTransactionSession } from "../session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SybaseUpdateResult {
  rowCount: number;
  affectedRows: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SybaseUpdateBuilder {
  private setValues: Record<string, unknown> = {};
  private whereCondition?: string;

  constructor(
    private readonly table: any,
    private readonly dialect: SybaseDialect,
    private readonly session: SybaseSession | SybaseTransactionSession
  ) {}

  set(values: Record<string, unknown>): this {
    this.setValues = values;
    return this;
  }

  where(condition: SQL): this {
    this.whereCondition = this.dialect.sqlToQuery(condition);
    return this;
  }

  toSQL(): string {
    return this.buildSql();
  }

  async execute(): Promise<SybaseUpdateResult> {
    const rawSql = this.buildSql();
    const result = await this.session.execute(rawSql);
    return { rowCount: result.rowCount, affectedRows: result.affectedRows };
  }

  then<TResult1 = SybaseUpdateResult, TResult2 = never>(
    onfulfilled?: ((value: SybaseUpdateResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private buildSql(): string {
    const columns = getTableColumns(this.table);
    const tableName = escapeName(getTable(this.table));

    const setClauses: string[] = [];

    for (const [fieldName, value] of Object.entries(this.setValues)) {
      if (value === undefined) {
        continue;
      }
      const col = columns[fieldName] as any;
      if (!col) {
        continue;
      }
      setClauses.push(`${escapeName(col.name)} = ${this.dialect.serializeColumnValue(value, col)}`);
    }

    // Apply onUpdate functions for columns not explicitly set
    for (const [fieldName, col] of Object.entries(columns) as [string, any][]) {
      if (col.onUpdateFn && this.setValues[fieldName] === undefined) {
        const onUpdateResult = col.onUpdateFn();
        setClauses.push(
          `${escapeName(col.name)} = ${this.dialect.serializeColumnValue(onUpdateResult, col)}`
        );
      }
    }

    if (setClauses.length === 0) {
      throw new Error("No columns to update");
    }

    let query = `update ${tableName} set ${setClauses.join(", ")}`;
    if (this.whereCondition) {
      query += ` where ${this.whereCondition}`;
    }
    return query;
  }
}
