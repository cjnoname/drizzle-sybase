import { and, eq, isNull, sql, sql as sql_ } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
/**
 * Query builder unit tests.
 * These tests verify SQL generation without requiring a real Sybase connection.
 */
import { describe, it, expect } from "vitest";

import { int, money, numeric, smallmoney, varchar } from "../../columns/index.js";
import { createSybaseDrizzle } from "../../db.js";
import { SybaseDialect, escapeName, escapeString, serializeValue } from "../../dialect.js";
import type { SybaseSession, SybaseTransactionSession } from "../../session.js";
import { sybaseTable } from "../../table.js";
import { SybaseDeleteBuilder } from "../delete.js";
import { SybaseInsertBuilder } from "../insert.js";
import type { InitialSelectState } from "../select-types.js";
import { SybaseSelectBuilder } from "../select.js";
import { SybaseUpdateBuilder } from "../update.js";

// ---------------------------------------------------------------------------
// Mock session that captures executed SQL
// ---------------------------------------------------------------------------

type MockableSession = SybaseSession | SybaseTransactionSession;

const usersForUndefinedWhere = sybaseTable("U", { name: varchar("name", { length: 5 }) });

function createMockSession(rows: Record<string, unknown>[] = []) {
  const executed: string[] = [];
  const mock = {
    executed,
    async execute<T extends Record<string, unknown> = Record<string, unknown>>(
      rawSql: string,
      _options?: { maxRows?: number }
    ) {
      executed.push(rawSql);
      return { rows: rows as T[], rowCount: rows.length, affectedRows: 0 };
    },
    async executeRaw(rawSql: string, _options?: { maxRows?: number }) {
      executed.push(rawSql);
      return { rows: [], columns: [], rowCount: 0, affectedRows: 0 };
    },
    async executeAtomic<T extends Record<string, unknown> = Record<string, unknown>>(
      rawSql: string
    ) {
      return mock.execute<T>(rawSql);
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

  // TOP, not SET ROWCOUNT: nothing is left in the session for the next pool user.
  it("generates SELECT with LIMIT as TOP", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(10).toSQL();
    expect(sql).toBe("select top 10 * from [users]");
  });

  // ASE accepts only DISTINCT before TOP.
  it("puts DISTINCT before TOP", () => {
    const builder = new SybaseSelectBuilder(dialect, createMockSession());
    expect(builder.from("users").distinct().limit(5).toSQL()).toBe(
      "select distinct top 5 * from [users]"
    );
  });

  it("generates SELECT with LIMIT + OFFSET", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(10).offset(20).toSQL();
    expect(sql).toBe("select top 30 * from [users]");
  });

  it.each([-1, 1.5, Number.NaN, Infinity, 2 ** 31, "1; drop table t" as unknown as number])(
    "rejects invalid limit/offset %j",
    value => {
      const builder = new SybaseSelectBuilder(dialect, createMockSession()).from("users");
      expect(() => builder.limit(value)).toThrow(RangeError);
      expect(() => builder.offset(value)).toThrow(RangeError);
    }
  );

  it("rejects offset + limit beyond the TOP range", () => {
    const builder = new SybaseSelectBuilder(dialect, createMockSession())
      .from("users")
      .limit(2 ** 30)
      .offset(2 ** 30);
    expect(() => builder.toSQL()).toThrow(RangeError);
  });

  it("limit(0) generates TOP 0 to return no rows", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    const sql = builder.from("users").limit(0).toSQL();
    expect(sql).toBe("select top 0 * from [users]");
  });

  // `where 1=0` alone is not enough: an aggregate without GROUP BY returns one
  // row over an empty input, so count(*) would come back as [{ n: 0 }].
  it("limit(0) returns no rows without running the query, even for an aggregate", async () => {
    const session = createMockSession([{ n: 0 }]);
    const builder = new SybaseSelectBuilder(dialect, session, [
      { expression: "count(*)", alias: "n" }
    ]);
    expect(await builder.from("users").limit(0)).toEqual([]);
    expect(session.executed).toEqual([]);
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

  it("has no FULL JOIN (ASE does not support it)", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    expect("fullJoin" in builder).toBe(false);
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

  // `and()` with no conditions returns undefined; drizzle treats that as "no WHERE".
  it("treats an undefined condition as none, as drizzle does", () => {
    const select = new SybaseSelectBuilder(dialect, createMockSession())
      .from("users")
      .where(and())
      .having(undefined)
      .toSQL();
    expect(select).toBe("select * from [users]");
    const update = new SybaseUpdateBuilder(usersForUndefinedWhere, dialect, createMockSession())
      .set({ name: "a" })
      .where(undefined)
      .toSQL();
    expect(update).toBe("update [U] set [name] = 'a'");
    const del = new SybaseDeleteBuilder(usersForUndefinedWhere, dialect, createMockSession())
      .where(and())
      .toSQL();
    expect(del).toBe("delete from [U]");
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

  it("has no CTE support (ASE has no WITH clause)", () => {
    const session = createMockSession();
    const builder = new SybaseSelectBuilder(dialect, session);
    expect("with" in builder).toBe(false);
  });

  it("supports from() with table object", () => {
    const session = createMockSession();
    const table = createMockTable("users", {
      id: createMockColumn("id"),
      name: createMockColumn("name")
    });
    const builder = new SybaseSelectBuilder(dialect, session);
    const result = builder.from(table).toSQL();
    expect(result).toBe("select [users].[id] as [id], [users].[name] as [name] from [users]");
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
    const joined = new SybaseSelectBuilder(dialect, createMockSession(), [{ expression: "1" }])
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

// ---------------------------------------------------------------------------
// Tests: identity values wider than a double
// ---------------------------------------------------------------------------

/**
 * `@@identity` is `numeric(38,0)`, so the driver returns it as digits and it can
 * exceed what a `number` holds exactly. Reporting a rounded id would be a silent
 * corruption of a primary key.
 */
describe("insertId precision", () => {
  const dialect = new SybaseDialect();
  const t = sybaseTable("T", {
    id: int("id").identity(),
    name: varchar("name", { length: 10 })
  });

  const insert = (identity: string) =>
    new SybaseInsertBuilder(t, dialect, createMockSession([{ "": identity }]) as any)
      .values({ name: "a" })
      .execute();

  it.each([
    ["1", 1],
    ["9007199254740991", 9007199254740991]
  ])("reports %s as a number when a double holds it exactly", async (digits, expected) => {
    const r = await insert(digits);
    expect(r.insertId).toBe(expected);
    expect(r.insertIdText).toBe(digits);
  });

  it.each(["9007199254740993", "123456789012345678901234567890"])(
    "refuses to round %s, keeping the digits instead",
    async digits => {
      const r = await insert(digits);
      expect(r.insertId).toBeUndefined();
      expect(r.insertIdText).toBe(digits);
    }
  );
});

describe("aliased columns (col.as)", () => {
  const db = createSybaseDrizzle({
    host: "h",
    port: 1,
    database: "d",
    username: "u",
    password: "p"
  });
  const people = sybaseTable("P", {
    id: int("ID").notNull(),
    name: varchar("NAME", { length: 20 })
  });

  // drizzle's semantics: an aliased column renders as its alias.
  it("orders by the alias", () => {
    const sqlText = db
      .select({ display: people.name })
      .from(people)
      .orderBy(people.name.as("display"))
      .toSQL();
    expect(sqlText).toBe("select [P].[NAME] as [display] from [P] order by [display]");
  });

  it("selects the original column when used as a field", () => {
    const sqlText = db
      .select({ who: people.name.as("ignored") })
      .from(people)
      .toSQL();
    expect(sqlText).toBe("select [P].[NAME] as [who] from [P]");
  });

  it("renders as the alias inside sql templates", () => {
    const sqlText = db
      .select({ id: people.id })
      .from(people)
      .where(sql_`${people.name.as("n")} is not null`)
      .toSQL();
    expect(sqlText).toContain("where [n] is not null");
  });

  it("leaves the column itself untouched", () => {
    people.name.as("other");
    expect(people.name.name).toBe("NAME");
    expect(people.name.isAlias).toBe(false);
  });
});

describe("default select fields", () => {
  const dialect = new SybaseDialect();
  const users = sybaseTable("USERS", { userId: int("USER_ID"), name: varchar("NAME") });
  const orders = sybaseTable("ORDERS", { orderId: int("ORDER_ID"), userId: int("USER_ID") });

  // `select *` returns database column names ({ USER_ID }), while the table
  // definition and the generated schemas use property names ({ userId }).
  it("selects every column of a schema table under its property name", () => {
    const sql = new SybaseSelectBuilder(dialect, createMockSession()).from(users).toSQL();
    expect(sql).toBe("select [USERS].[USER_ID] as [userId], [USERS].[NAME] as [name] from [USERS]");
  });

  it("includes joined tables' columns", () => {
    const products = sybaseTable("P", { sku: varchar("SKU") });
    const sql = new SybaseSelectBuilder(dialect, createMockSession())
      .from(users)
      .innerJoin(products, sql_`1=1`)
      .toSQL();
    expect(sql).toContain("[P].[SKU] as [sku]");
  });

  // A flat row cannot hold two `userId`s; silently keeping one would lose data.
  // Typed callers are stopped at compile time (see inference.test-d.ts); this
  // runtime check is for everyone else.
  it("refuses an implicit select whose joined properties collide", () => {
    const builder = new SybaseSelectBuilder<InitialSelectState<undefined>>(
      dialect,
      createMockSession()
    )
      .from(users)
      // @ts-expect-error -- the clash is a type error too
      .innerJoin(orders, eq(users.userId, orders.userId));
    expect(() => builder.toSQL()).toThrow(/userId.*select\(\{/s);
  });

  it("keeps select * for a table given by name", () => {
    const sql = new SybaseSelectBuilder(dialect, createMockSession()).from("USERS").toSQL();
    expect(sql).toBe("select * from [USERS]");
  });

  it("leaves explicit fields alone", () => {
    const sql = new SybaseSelectBuilder(dialect, createMockSession(), [
      { expression: "count(*)", alias: "n" }
    ])
      .from(users)
      .toSQL();
    expect(sql).toBe("select count(*) as [n] from [USERS]");
  });
});

describe("owner-qualified tables", () => {
  const dialect = new SybaseDialect();
  const t = sybaseTable("T", { id: int("ID"), name: varchar("NAME") }, { owner: "alice" });

  it("qualifies the table in select, insert, update and delete", () => {
    const session = createMockSession();
    expect(new SybaseSelectBuilder(dialect, session).from(t).where(eq(t.id, 1)).toSQL()).toBe(
      "select [alice].[T].[ID] as [id], [alice].[T].[NAME] as [name] from [alice].[T] " +
        "where [alice].[T].[ID] = 1"
    );
    expect(new SybaseInsertBuilder(t, dialect, session).values({ name: "x" }).toSQL()).toBe(
      "insert into [alice].[T] ([NAME]) values ('x')"
    );
    expect(new SybaseUpdateBuilder(t, dialect, session).set({ name: "x" }).toSQL()).toBe(
      "update [alice].[T] set [NAME] = 'x'"
    );
    expect(new SybaseDeleteBuilder(t, dialect, session).toSQL()).toBe("delete from [alice].[T]");
  });
});
