/**
 * Sybase INSERT query builder.
 *
 * Key Sybase differences:
 * - No RETURNING / OUTPUT clause
 * - Identity value retrieved via SELECT @@identity after INSERT
 * - Sybase ASE does NOT support multi-row VALUES — each row is a separate INSERT
 * - Omitted columns let DB defaults apply
 *
 * @example
 * ```ts
 * // Single insert
 * const result = await db.insert(users).values({ name: "Alice", email: "alice@example.com" });
 * console.log(result.insertId); // Auto-increment ID
 *
 * // Multi-row insert (generates separate INSERT statements)
 * await db.insert(users).values([
 *   { name: "Bob", email: "bob@example.com" },
 *   { name: "Charlie", email: "charlie@example.com" }
 * ]);
 * ```
 */
import { getTableName } from "drizzle-orm";

import { escapeName, type SybaseDialect } from "../dialect.js";

/** @internal */
const ColumnsSymbol = Symbol.for("drizzle:Columns");
import type { SybaseSession, SybaseTransactionSession } from "../session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SybaseInsertResult {
  rowCount: number;
  /**
   * Last @@identity value (for tables with identity columns).
   * When inserting multiple rows, only the identity of the LAST inserted row is returned
   * (Sybase ASE limitation — no OUTPUT/RETURNING clause support).
   */
  insertId?: number;
  /**
   * The same value as digits, exact at any width.
   *
   * `@@identity` is `numeric(38,0)`, so it can hold more than a double: an
   * identity past 2^53 has no exact `number`, and {@link insertId} is `undefined`
   * rather than a rounded one. This is always populated when the table has an
   * identity column and the insert returned a value.
   */
  insertIdText?: string;
  affectedRows: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class SybaseInsertBuilder {
  private table: any;
  private insertValues: Record<string, unknown>[] = [];

  constructor(
    table: any,
    private readonly dialect: SybaseDialect,
    private readonly session: SybaseSession | SybaseTransactionSession
  ) {
    this.table = table;
  }

  values(values: Record<string, unknown> | Record<string, unknown>[]): this {
    const arr = Array.isArray(values) ? values : [values];
    if (arr.length === 0) {
      throw new Error("Cannot insert empty array of values. Provide at least one row.");
    }
    this.insertValues = arr;
    return this;
  }

  toSQL(): string {
    return this.buildSql();
  }

  async execute(): Promise<SybaseInsertResult> {
    const fullSql = this.buildSql();
    const result = await this.session.execute<Record<string, string>>(fullSql);

    const hasIdentity = this.hasIdentityColumn();
    let insertId: number | undefined;
    let insertIdText: string | undefined;
    if (hasIdentity && result.rows.length > 0) {
      const raw = Object.values(result.rows[0]!)[0];
      // @@identity is numeric(38,0), which the driver hands over as digits.
      const digits = raw === null || raw === undefined ? "" : String(raw).trim();
      if (digits !== "") {
        insertIdText = digits;
        const parsed = Number(digits);
        // Only report a number when a double holds it exactly. Rounding a wide
        // identity would be the one thing this driver does not do to a value.
        insertId = Number.isSafeInteger(parsed) ? parsed : undefined;
      }
    }

    return {
      rowCount: this.insertValues.length,
      insertId,
      insertIdText,
      affectedRows: result.affectedRows
    };
  }

  then<TResult1 = SybaseInsertResult, TResult2 = never>(
    onfulfilled?: ((value: SybaseInsertResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private hasIdentityColumn(): boolean {
    const columns = this.table[ColumnsSymbol];
    return Object.values(columns).some((col: any) => !!col.identity);
  }

  private buildSql(): string {
    const statements = this.buildInsertStatements();
    const hasIdentity = this.hasIdentityColumn();

    const parts = [...statements];
    if (hasIdentity) {
      parts.push("SELECT @@identity");
    }
    return parts.join("\n");
  }

  private buildInsertStatements(): string[] {
    const columns = this.table[ColumnsSymbol];

    const allColEntries = Object.entries(columns).filter(
      ([_, col]: [string, any]) => !col.shouldDisableInsert()
    );

    const tableName = escapeName(getTableName(this.table));

    return this.insertValues.map(row => {
      const providedEntries = allColEntries.filter(([fieldName, col]: [string, any]) => {
        const value = row[fieldName];
        if (value !== undefined) {
          return true;
        }
        if (col.defaultFn) {
          return true;
        }
        if (col.onUpdateFn) {
          return true;
        }
        return false;
      });

      if (providedEntries.length === 0) {
        // Sybase ASE does not support VALUES (DEFAULT) syntax.
        // User must provide at least one column value, or the column
        // must have a defaultFn defined in the schema.
        throw new Error(
          `Cannot insert into ${tableName}: no columns with values provided. ` +
            `Sybase ASE requires at least one explicit column value in INSERT.`
        );
      }

      const colNames = providedEntries.map(([_, col]: [string, any]) => escapeName(col.name));
      const values = providedEntries.map(([fieldName, col]: [string, any]) => {
        const value = row[fieldName];
        if (value === undefined) {
          if (col.defaultFn) {
            return this.dialect.serializeColumnValue(col.defaultFn(), col);
          }
          if (col.onUpdateFn) {
            return this.dialect.serializeColumnValue(col.onUpdateFn(), col);
          }
          return "NULL";
        }
        return this.dialect.serializeColumnValue(value, col);
      });

      return `insert into ${tableName} (${colNames.join(", ")}) values (${values.join(", ")})`;
    });
  }
}
