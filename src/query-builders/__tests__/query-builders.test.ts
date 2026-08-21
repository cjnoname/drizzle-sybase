import { eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
/**
 * Query builder unit tests.
 * These tests verify SQL generation without requiring a real Sybase connection.
 */
import { describe, it, expect } from "vitest";

import { money, numeric, smallmoney, varchar } from "../../columns/index.js";
import { SybaseDialect, escapeName, escapeString, serializeValue } from "../../dialect.js";
import type { SybaseSession, SybaseTransactionSession } from "../../session.js";
import { sybaseTable } from "../../table.js";
import { SybaseDeleteBuilder } from "../delete.js";
import { SybaseInsertBuilder } from "../insert.js";
import { SybaseSelectBuilder } from "../select.js";
import { SybaseUpdateBuilder } from "../update.js";

// ---------------------------------------------------------------------------
// Mock session that captures executed SQL
// ---------------------------------------------------------------------------

type MockableSession = SybaseSession | SybaseTransactionSession;

function createMockSession() {
  const executed: string[] = [];
  const mock = {
    executed,
    async execute<T extends Record<string, unknown> = Record<string, unknown>>(
      rawSql: string,
      _options?: { maxRows?: number }
    ) {
      executed.push(rawSql);
      return { rows: [] as T[], rowCount: 0, affectedRows: 0 };
    },
    async executeRaw(rawSql: string, _options?: { maxRows?: number }) {
      executed.push(rawSql);
      return { rows: [], columns: [], rowCount: 0, affectedRows: 0 };
    }
  };
  return mock as unknown as MockableSession & { executed: string[] };
}

// ---------------------------------------------------------------------------
// Mock table
// ---------------------------------------------------------------------------

const ColumnsSymbol = Symbol.for("drizzle:Columns");
const NameSymbol = Symbol.for("drizzle:Name");

function createMockTable(name: string, columns: Record<string, any>) {
  const table: any = {
    [NameSymbol]: name,
    [ColumnsSymbol]: columns
  };
  // Set table reference on each column
  for (const col of Object.values(columns)) {
    col.table = table;
  }
  return table;
}

function createMockColumn(
  name: string,
  options?: {
    identity?: boolean;
    defaultFn?: () => unknown;
    onUpdateFn?: () => unknown;
    mapToDriverValue?: (v: unknown) => unknown;
  }
) {
  return {
    name,
    identity: options?.identity ? {} : undefined,
    defaultFn: options?.defaultFn,
    onUpdateFn: options?.onUpdateFn,
    mapToDriverValue: options?.mapToDriverValue,
    shouldDisableInsert() {
      return !!options?.identity;
    },
    table: null as any // Will be set by createMockTable
  };
}

// ---------------------------------------------------------------------------
// Tests: SybaseSelectBuilder
// ---------------------------------------------------------------------------

describe("SybaseSelectBuilder", () => {
  const dialect = new SybaseDialect();

  it("generates basic SELECT *", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").toSQL();
    expect(sql).toBe("select * from [users]");
  });

  it("generates SELECT with specific fields", () => {
    const session = createMockSession();
    const fields = [
      { expression: "[id]", alias: "id" },
      { expression: "[name]", alias: "name" }
    ];
    const builder = new SybaseSelectBuilder(dialect, session, fields);
    const sql = builder.from("users").toSQL();
    expect(sql).toBe("select [id] as [id], [name] as [name] from [users]");
  });

  it("generates SELECT DISTINCT", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").distinct().toSQL();
    expect(sql).toBe("select distinct * from [users]");
  });

  it("generates SELECT with LIMIT (SET ROWCOUNT)", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(10).toSQL();
    expect(sql).toBe("SET ROWCOUNT 10\nselect * from [users]\nSET ROWCOUNT 0");
  });

  it("generates SELECT with LIMIT + OFFSET", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(10).offset(20).toSQL();
    expect(sql).toBe("SET ROWCOUNT 30\nselect * from [users]\nSET ROWCOUNT 0");
  });

  it("ignores negative offset", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(5).offset(-1).toSQL();
    expect(sql).toBe("SET ROWCOUNT 5\nselect * from [users]\nSET ROWCOUNT 0");
  });

  it("limit(0) generates WHERE 1=0 to return no rows", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(0).toSQL();
    expect(sql).toContain("where 1=0");
  });

  it("ignores negative limit", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(-1).toSQL();
    expect(sql).toBe("select * from [users]");
  });

  it("execute() calls session and returns rows", async () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const rows = await builder.from("users").execute();
    expect(rows).toEqual([]);
    expect(session.executed.length).toBe(1);
    expect(session.executed[0]).toBe("select * from [users]");
  });

  it("execute() with offset slices results", async () => {
    // Create a session that returns mock rows
    const mockSession = {
      async execute(_rawSql: string, _options?: { maxRows?: number }) {
        return {
          rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
          rowCount: 5,
          affectedRows: 0
        };
      },
      async executeRaw(_rawSql: string) {
        return { rows: [], columns: [], rowCount: 0, affectedRows: 0 };
      }
    } as unknown as MockableSession;
    const builder = new SybaseSelectBuilder(dialect, mockSession);
    const rows = await builder.from("users").limit(3).offset(2).execute();
    // Should skip first 2 rows and return rows 3-5
    expect(rows).toEqual([{ id: 3 }, { id: 4 }, { id: 5 }]);
  });

  it("generates SELECT with ORDER BY string", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").orderBy("name asc", "id desc").toSQL();
    expect(sql).toBe("select * from [users] order by name asc, id desc");
  });

  it("generates SELECT with GROUP BY", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("orders").groupBy("status").toSQL();
    expect(sql).toBe("select * from [orders] group by status");
  });

  it("generates SELECT with INNER JOIN", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const joinOn = sql`[users].[id] = [orders].[user_id]`;
    const result = builder.from("users").innerJoin("orders", joinOn).toSQL();
    expect(result).toContain("inner join [orders] on");
  });

  it("generates SELECT with LEFT JOIN", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const joinOn = sql`[users].[id] = [orders].[user_id]`;
    const result = builder.from("users").leftJoin("orders", joinOn).toSQL();
    expect(result).toContain("left join [orders] on");
  });

  it("generates SELECT with RIGHT JOIN", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const joinOn = sql`[users].[id] = [orders].[user_id]`;
    const result = builder.from("users").rightJoin("orders", joinOn).toSQL();
    expect(result).toContain("right join [orders] on");
  });

  it("generates SELECT with FULL JOIN", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const joinOn = sql`[users].[id] = [orders].[user_id]`;
    const result = builder.from("users").fullJoin("orders", joinOn).toSQL();
    expect(result).toContain("full join [orders] on");
  });

  it("generates SELECT with multiple JOINs", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const joinOn1 = sql`[u].[id] = [o].[user_id]`;
    const joinOn2 = sql`[o].[id] = [p].[order_id]`;
    const result = builder
      .from("users")
      .innerJoin("orders", joinOn1)
      .leftJoin("payments", joinOn2)
      .toSQL();
    expect(result).toContain("inner join [orders] on");
    expect(result).toContain("left join [payments] on");
  });

  it("generates SELECT with WHERE using sql template", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const result = builder
      .from("users")
      .where(sql`[name] = ${"Alice"}`)
      .toSQL();
    expect(result).toContain("where");
    expect(result).toContain("'Alice'");
  });

  it("supports CTE (WITH clause)", () => {
    const session = createMockSession();
    const fields = [{ expression: "*" }];
    const builder = new SybaseSelectBuilder(dialect, session, fields);
    // Manually set config for CTE
    const result = builder as any;
    result.config = {
      fields,
      table: "[users]",
      withList: [{ alias: "active_users", sql: "select * from [users] where active = 1" }]
    };
    const sqlStr = result.buildSql();
    expect(sqlStr).toContain("with [active_users] as (select * from [users] where active = 1)");
  });

  it("supports from() with table object", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      id: createMockColumn("id"),
      name: createMockColumn("name")
    });
    const builder = new SybaseSelectBuilder(dialect, session);
    const result = builder.from(table).toSQL();
    expect(result).toBe("select * from [users]");
  });
});

// ---------------------------------------------------------------------------
// Tests: SybaseInsertBuilder
// ---------------------------------------------------------------------------

describe("SybaseInsertBuilder", () => {
  const dialect = new SybaseDialect();

  it("generates basic INSERT", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      id: createMockColumn("id", { identity: true }),
      name: createMockColumn("name"),
      email: createMockColumn("email")
    });

    const builder = new SybaseInsertBuilder(table, dialect, session);
    const sql = builder.values({ name: "Alice", email: "alice@test.com" }).toSQL();
    expect(sql).toContain("insert into [users]");
    expect(sql).toContain("[name]");
    expect(sql).toContain("'Alice'");
    expect(sql).toContain("'alice@test.com'");
    // Identity column should trigger @@identity select
    expect(sql).toContain("SELECT @@identity");
  });

  it("generates multiple INSERT statements for array values", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name"),
      email: createMockColumn("email")
    });

    const builder = new SybaseInsertBuilder(table, dialect, session);
    const sql = builder
      .values([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" }
      ])
      .toSQL();

    const lines = sql.split("\n");
    expect(lines.filter(l => l.startsWith("insert into"))).toHaveLength(2);
  });

  it("handles defaultFn columns", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name"),
      createdAt: createMockColumn("created_at", {
        defaultFn: () => new Date("2024-01-01T00:00:00Z")
      })
    });

    const builder = new SybaseInsertBuilder(table, dialect, session);
    const sql = builder.values({ name: "Alice" }).toSQL();
    expect(sql).toContain("[created_at]");
    expect(sql).toContain("2024-01-01 00:00:00");
  });

  it("handles NULL values", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name"),
      email: createMockColumn("email")
    });

    const builder = new SybaseInsertBuilder(table, dialect, session);
    const sql = builder.values({ name: "Alice", email: null }).toSQL();
    expect(sql).toContain("NULL");
  });

  it("uses mapToDriverValue when available", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name"),
      active: createMockColumn("active", {
        mapToDriverValue: (v: unknown) => (v ? 1 : 0)
      })
    });

    const builder = new SybaseInsertBuilder(table, dialect, session);
    const sql = builder.values({ name: "Alice", active: true }).toSQL();
    expect(sql).toContain("1");
  });

  it("throws for empty values array", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name")
    });

    const builder = new SybaseInsertBuilder(table, dialect, session);
    expect(() => builder.values([])).toThrow("Cannot insert empty array");
  });

  it("execute() calls session and returns result", async () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name")
    });

    const builder = new SybaseInsertBuilder(table, dialect, session);
    const result = await builder.values({ name: "Test" }).execute();
    expect(result.rowCount).toBe(1);
    expect(result.affectedRows).toBe(0); // mock returns 0
    expect(session.executed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: SybaseUpdateBuilder
// ---------------------------------------------------------------------------

describe("SybaseUpdateBuilder", () => {
  const dialect = new SybaseDialect();

  it("generates basic UPDATE", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      id: createMockColumn("id"),
      name: createMockColumn("name"),
      email: createMockColumn("email")
    });

    const builder = new SybaseUpdateBuilder(table, dialect, session);
    const result = builder.set({ name: "Bob" }).toSQL();
    expect(result).toBe("update [users] set [name] = 'Bob'");
  });

  it("generates UPDATE with WHERE", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      id: createMockColumn("id"),
      name: createMockColumn("name")
    });

    const builder = new SybaseUpdateBuilder(table, dialect, session);
    const result = builder
      .set({ name: "Bob" })
      .where(sql`[id] = ${1}`)
      .toSQL();
    expect(result).toContain("update [users] set [name] = 'Bob'");
    expect(result).toContain("where");
    expect(result).toContain("1");
  });

  it("handles multiple SET columns", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name"),
      email: createMockColumn("email")
    });

    const builder = new SybaseUpdateBuilder(table, dialect, session);
    const result = builder.set({ name: "Bob", email: "bob@test.com" }).toSQL();
    expect(result).toContain("[name] = 'Bob'");
    expect(result).toContain("[email] = 'bob@test.com'");
  });

  it("applies onUpdateFn for columns not explicitly set", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name"),
      updatedAt: createMockColumn("updated_at", {
        onUpdateFn: () => new Date("2024-06-15T12:00:00Z")
      })
    });

    const builder = new SybaseUpdateBuilder(table, dialect, session);
    const result = builder.set({ name: "Bob" }).toSQL();
    expect(result).toContain("[updated_at]");
    expect(result).toContain("2024-06-15 12:00:00");
  });

  it("skips undefined values", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name"),
      email: createMockColumn("email")
    });

    const builder = new SybaseUpdateBuilder(table, dialect, session);
    const result = builder.set({ name: "Bob", email: undefined }).toSQL();
    expect(result).toContain("[name] = 'Bob'");
    expect(result).not.toContain("[email]");
  });

  it("throws if no columns to update", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      name: createMockColumn("name")
    });

    const builder = new SybaseUpdateBuilder(table, dialect, session);
    expect(() => builder.set({}).toSQL()).toThrow("No columns to update");
  });
});

// ---------------------------------------------------------------------------
// Tests: SybaseDeleteBuilder
// ---------------------------------------------------------------------------

describe("SybaseDeleteBuilder", () => {
  const dialect = new SybaseDialect();

  it("generates basic DELETE", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      id: createMockColumn("id")
    });

    const builder = new SybaseDeleteBuilder(table, dialect, session);
    const result = builder.toSQL();
    expect(result).toBe("delete from [users]");
  });

  it("generates DELETE with WHERE", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      id: createMockColumn("id")
    });

    const builder = new SybaseDeleteBuilder(table, dialect, session);
    const result = builder.where(sql`[id] = ${42}`).toSQL();
    expect(result).toContain("delete from [users]");
    expect(result).toContain("where");
    expect(result).toContain("42");
  });
});

// ---------------------------------------------------------------------------
// Tests: serializeValue edge cases
// ---------------------------------------------------------------------------

describe("serializeValue edge cases", () => {
  it("throws for NaN", () => {
    expect(() => serializeValue(NaN)).toThrow("non-finite");
  });

  it("throws for Infinity", () => {
    expect(() => serializeValue(Infinity)).toThrow("non-finite");
  });

  it("throws for -Infinity", () => {
    expect(() => serializeValue(-Infinity)).toThrow("non-finite");
  });

  it("throws for invalid Date", () => {
    expect(() => serializeValue(new Date("invalid"))).toThrow("invalid Date");
  });

  it("serializes bigint", () => {
    expect(serializeValue(BigInt("9007199254740993"))).toBe("9007199254740993");
  });

  it("serializes Buffer to hex literal", () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect(serializeValue(buf)).toBe("0xdeadbeef");
  });

  it("throws for Array values", () => {
    expect(() => serializeValue([1, 2, 3])).toThrow("Cannot serialize Array");
  });

  it("throws for plain Object values", () => {
    expect(() => serializeValue({ foo: "bar" })).toThrow("Cannot serialize object");
  });

  it("handles strings with null bytes", () => {
    expect(escapeString("hello\0world")).toBe("'helloworld'");
  });

  it("handles empty string", () => {
    expect(escapeString("")).toBe("''");
  });

  it("handles unicode strings", () => {
    expect(escapeString("你好世界")).toBe("'你好世界'");
  });

  it("handles strings with multiple special chars", () => {
    expect(escapeString("it's a \0'test'")).toBe("'it''s a ''test'''");
  });
});

// ---------------------------------------------------------------------------
// Tests: escapeName edge cases
// ---------------------------------------------------------------------------

describe("escapeName edge cases", () => {
  it("handles empty string", () => {
    expect(escapeName("")).toBe("[]");
  });

  it("handles name with multiple brackets", () => {
    expect(escapeName("a]b]c")).toBe("[a]]b]]c]");
  });

  it("handles name with spaces", () => {
    expect(escapeName("my table")).toBe("[my table]");
  });
});

// ---------------------------------------------------------------------------
// Tests: exact numeric parameters (CONVERT)
// ---------------------------------------------------------------------------

/**
 * ASE refuses a quoted literal against money/numeric ("Msg 257: Implicit
 * conversion from datatype 'VARCHAR' to 'MONEY' is not allowed"), and these are
 * exactly the types the driver returns as strings — so every place a value can
 * reach the statement has to wrap them, not just INSERT/UPDATE values.
 */
describe("exact numeric parameters", () => {
  const dialect = new SybaseDialect();
  const winf = sybaseTable("WINF", {
    key: varchar("WINFkey", { length: 10 }).primaryKey(),
    totPrRoyalty: money("tot_pr_royalty"),
    pocket: smallmoney("pocket"),
    pct: numeric("percentage", { precision: 7, scale: 4 }),
    wide: numeric("wide", { precision: 20, scale: 0 }),
    unsized: numeric("unsized")
  });

  const selectWhere = (condition: SQL): string =>
    new SybaseSelectBuilder(dialect, createMockSession()).from(winf).where(condition).toSQL();

  it("wraps a money literal in WHERE", () => {
    expect(selectWhere(eq(winf.totPrRoyalty, "922337203685477.5807"))).toContain(
      "= convert(money, '922337203685477.5807')"
    );
  });

  it("wraps smallmoney and sized numeric in WHERE", () => {
    expect(selectWhere(eq(winf.pocket, "-214748.3647"))).toContain(
      "convert(smallmoney, '-214748.3647')"
    );
    expect(selectWhere(eq(winf.pct, "12.3456"))).toContain("convert(numeric(7,4), '12.3456')");
    expect(selectWhere(eq(winf.wide, "99999999999999999999"))).toContain(
      "convert(numeric(20,0), '99999999999999999999')"
    );
  });

  it("wraps money literals in JOIN ... ON and HAVING", () => {
    const joined = new SybaseSelectBuilder(dialect, createMockSession())
      .from(winf)
      .innerJoin(winf, eq(winf.totPrRoyalty, "1.5000"))
      .toSQL();
    expect(joined).toContain("convert(money, '1.5000')");

    const having = new SybaseSelectBuilder(dialect, createMockSession())
      .from(winf)
      .groupBy(winf.key)
      .having(eq(winf.totPrRoyalty, "1.5000"))
      .toSQL();
    expect(having).toContain("convert(money, '1.5000')");
  });

  it("wraps money literals in DELETE and UPDATE predicates", () => {
    const deleted = new SybaseDeleteBuilder(winf, dialect, createMockSession())
      .where(eq(winf.totPrRoyalty, "1.5000"))
      .toSQL();
    expect(deleted).toContain("convert(money, '1.5000')");

    const updated = new SybaseUpdateBuilder(winf, dialect, createMockSession())
      .set({ key: "W1" })
      .where(eq(winf.totPrRoyalty, "1.5000"))
      .toSQL();
    expect(updated).toContain("convert(money, '1.5000')");
  });

  it("wraps money values in INSERT and UPDATE assignments", () => {
    const inserted = new SybaseInsertBuilder(winf, dialect, createMockSession())
      .values({ key: "W1", totPrRoyalty: "1.5000" })
      .toSQL();
    expect(inserted).toContain("convert(money, '1.5000')");

    const updated = new SybaseUpdateBuilder(winf, dialect, createMockSession())
      .set({ totPrRoyalty: "1.5000" })
      .toSQL();
    expect(updated).toContain("[tot_pr_royalty] = convert(money, '1.5000')");
  });

  // A bare numeric/decimal would default to (18,0) in ASE, silently rounding the
  // fraction away, so it is left to fail loudly instead.
  it("leaves an unsized numeric alone", () => {
    expect(selectWhere(eq(winf.unsized, "1.5"))).toContain("= '1.5'");
  });

  it("leaves strings bound to other types alone", () => {
    expect(selectWhere(eq(winf.key, "W1"))).toContain("= 'W1'");
  });

  // Numbers already serialize as bare literals, which ASE converts implicitly.
  it("does not wrap numbers or NULL", () => {
    expect(selectWhere(eq(winf.totPrRoyalty, 1.5))).toContain("= 1.5");
    expect(selectWhere(isNull(winf.totPrRoyalty))).toContain("is null");
  });

  it("does not wrap non-literal strings", () => {
    for (const value of ["1e5", "abc", "1' or '1"]) {
      expect(selectWhere(eq(winf.totPrRoyalty, value))).toContain(serializeValue(value));
      expect(selectWhere(eq(winf.totPrRoyalty, value))).not.toContain("convert(");
    }
  });

  it("leaves raw sql templates untouched", () => {
    expect(selectWhere(sql`${winf.totPrRoyalty} > 0`)).toContain("[tot_pr_royalty] > 0");
  });

  // A bare value interpolated into a raw template carries no column, so there is
  // nothing to key a codec off and it stays a plain literal — which ASE rejects.
  // `sql.param(value, column)` is the way to opt in.
  it("wraps a raw template parameter when it is bound to the column", () => {
    expect(selectWhere(sql`${winf.totPrRoyalty} = ${"1.5000"}`)).toContain("= '1.5000'");
    expect(
      selectWhere(sql`${winf.totPrRoyalty} = ${sql.param("1.5000", winf.totPrRoyalty)}`)
    ).toContain("= convert(money, '1.5000')");
  });
});
