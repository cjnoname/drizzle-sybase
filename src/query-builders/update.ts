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

import { escapeName, escapeTableName, type SybaseDialect } from "../dialect.js";
import type {
  SybaseConnectionSession,
  SybaseSession,
  SybaseTransactionSession
} from "../session.js";
import type { AnySybaseTable, SybaseUpdateValues } from "../table.js";

/** @internal */
const ColumnsSymbol = Symbol.for("drizzle:Columns");

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

export class SybaseUpdateBuilder<TTable extends AnySybaseTable = AnySybaseTable> {
  private setValues: Record<string, unknown> = {};
  private whereCondition?: string;

  constructor(
    private readonly table: TTable,
    private readonly dialect: SybaseDialect,
    private readonly session: SybaseSession | SybaseTransactionSession | SybaseConnectionSession
  ) {}

  set(values: SybaseUpdateValues<TTable>): this {
    this.setValues = values;
    return this;
  }

  /** `undefined` (as `and()` of no conditions returns) means no condition, as in drizzle. */
  where(condition: SQL | undefined): this {
    this.whereCondition = condition ? this.dialect.sqlToQuery(condition) : undefined;
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
    const columns: Record<string, any> = (this.table as any)[ColumnsSymbol];
    const tableName = escapeTableName(this.table);

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
