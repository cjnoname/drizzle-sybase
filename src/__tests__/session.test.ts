/**
 * Session wiring.
 *
 * `datetime.test.ts` covers the conversion itself; these tests cover the part
 * that is easy to get silently wrong — whether the configured zone actually
 * reaches the code that decodes rows, on every path (plain query, transaction)
 * and through `createSybaseDrizzle`.
 */
import { Subquery, eq, getColumns, max, min, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { describe, it, expect, vi } from "vitest";

import { datetime, money, varchar } from "../columns/index.js";
import type { QueryResult, SybaseQueryOptions } from "../connection.js";
import { SybaseConnection } from "../connection.js";
import { createSybaseDrizzle } from "../db.js";
import type { SybasePoolConfig } from "../pool.js";
import { SybasePool } from "../pool.js";
import { toColumnarResult, toRowResult } from "../result.js";
import type { NativeResult } from "../result.js";
import { SybaseSession, SybaseTransactionSession } from "../session.js";
import { sybaseTable } from "../table.js";

const SYDNEY = "Australia/Sydney";

/** Enough of a config to construct a pool; nothing here connects. */
const config = {
  host: "localhost",
  port: 5000,
  database: "db",
  username: "u",
  password: "p"
};

/** The canonical text `binding.c` produces for a datetime column. */
const STORED = "2016-06-09 09:48:46.753";
/** The same wall clock as the number `binding.c` hands over when asked for a zone. */
const STORED_WALL_CLOCK = Date.UTC(2016, 5, 9, 9, 48, 46, 753);
const AS_SYDNEY = "2016-06-08T23:48:46.753Z";
const AS_UTC = "2016-06-09T09:48:46.753Z";

/**
 * What the addon answers to a query, in the form it would given these options:
 * datetime columns arrive as wall clocks only when a zone is asked for.
 */
const nativeAnswer = (options?: SybaseQueryOptions): NativeResult => ({
  columns: ["dt_rec_added", "title", "tot_pr_royalty"],
  columnTypes: ["datetime", "varchar", "money"],
  data: [
    options?.timeZone === undefined
      ? { kind: "text", values: [STORED], units: Uint32Array.of(STORED.length), nulls: undefined }
      : { kind: "wallclock", values: Float64Array.of(STORED_WALL_CLOCK), nulls: undefined },
    {
      kind: "text",
      values: ["SOME SONG"],
      units: Uint32Array.of("SOME SONG".length),
      nulls: undefined
    },
    { kind: "text", values: ["0.0000"], units: Uint32Array.of("0.0000".length), nulls: undefined }
  ],
  rowCount: 1,
  affectedRows: 0
});

const result = (overrides?: Partial<QueryResult>): QueryResult => ({
  rows: [],
  columns: [],
  columnTypes: [],
  rowCount: 0,
  affectedRows: 0,
  ...overrides
});

/**
 * What the server answers to the session's own state queries, or `undefined`
 * for anything else. Mirrors the real shape (one row, one int column) so the
 * session's strict checks see what they would against ASE.
 */
const serverVar = (sql: string, vars: { tc?: number; iso?: number } = {}) => {
  const one = (key: string, value: number) =>
    result({ rows: [{ [key]: value }], columns: [key], columnTypes: ["int"], rowCount: 1 });
  if (sql.includes("@@trancount as tc")) {
    return one("tc", vars.tc ?? 1);
  }
  if (sql.includes("@@isolation as iso")) {
    return one("iso", vars.iso ?? 1);
  }
  return undefined;
};

/**
 * Pool stub exposing only what the session touches. Queries are answered the
 * way the real connection would, decoding {@link nativeAnswer} with the options
 * the session passed — so the tests see whether the zone reaches the decoder.
 */
const fakePool = (vars: { tc?: number; iso?: number } = {}) => {
  const executed: string[] = [];
  const answer = async (sql: string, options?: SybaseQueryOptions) => {
    executed.push(sql);
    return serverVar(sql, vars) ?? toRowResult(nativeAnswer(options), options?.timeZone);
  };
  const answerColumns = async (sql: string, options?: SybaseQueryOptions) => {
    executed.push(sql);
    return toColumnarResult(nativeAnswer(options), options?.timeZone);
  };
  const conn = {
    isConnected: true,
    query: answer,
    queryColumns: answerColumns,
    resetSessionState: async () => {
      executed.push("RESET");
      return { leftOpen: false };
    },
    close: () => {}
  } as unknown as SybaseConnection;
  const pool = {
    logger: undefined,
    query: answer,
    queryColumns: answerColumns,
    acquire: async () => conn,
    release: () => {}
  } as unknown as SybasePool;
  return { pool, conn, executed };
};

describe("SybaseSession datetime decoding", () => {
  it("decodes datetime columns in the configured zone", async () => {
    const { pool } = fakePool();
    const { rows } = await new SybaseSession(pool, SYDNEY).execute("select 1");
    expect((rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_SYDNEY);
  });

  // Not "returns raw text": a driver that hands back Date or string depending on
  // configuration forces every caller to handle a union the schema never mentions.
  it("decodes in UTC when no zone is configured", async () => {
    const { pool } = fakePool();
    const { rows } = await new SybaseSession(pool).execute("select 1");
    expect(rows[0]!.dt_rec_added).toBeInstanceOf(Date);
    expect((rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_UTC);
  });

  it("leaves money and varchar columns alone", async () => {
    const { pool } = fakePool();
    const { rows } = await new SybaseSession(pool, SYDNEY).execute("select 1");
    expect(rows[0]!.tot_pr_royalty).toBe("0.0000");
    expect(rows[0]!.title).toBe("SOME SONG");
  });

  it("decodes on executeRaw too, keeping the result metadata", async () => {
    const { pool } = fakePool();
    const raw = await new SybaseSession(pool, SYDNEY).executeRaw("select 1");
    expect((raw.rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_SYDNEY);
    expect(raw.columns).toEqual(["dt_rec_added", "title", "tot_pr_royalty"]);
    expect(raw.columnTypes).toEqual(["datetime", "varchar", "money"]);
  });

  it("decodes on executeColumns", async () => {
    const { pool } = fakePool();
    const { columns } = await new SybaseSession(pool, SYDNEY).executeColumns("select 1");
    // Epoch milliseconds: the instant the row form's Date holds.
    expect(columns[0]!.values).toEqual(Float64Array.of(Date.parse(AS_SYDNEY)));
    expect(columns.map(column => column.type)).toEqual(["datetime", "varchar", "money"]);
  });

  it("decodes inside a transaction, with the zone the session was given", async () => {
    const { pool } = fakePool();
    const rows = await new SybaseSession(pool, SYDNEY).transaction(async tx => {
      const r = await tx.execute("select 1");
      return r.rows;
    });
    expect((rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_SYDNEY);
  });

  it("decodes on a transaction session's executeRaw and executeColumns", async () => {
    const { conn } = fakePool();
    const tx = new SybaseTransactionSession(conn, undefined, SYDNEY);
    const raw = await tx.executeRaw("select 1");
    expect((raw.rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_SYDNEY);
    const { columns } = await tx.executeColumns("select 1");
    expect(columns[0]!.values).toEqual(Float64Array.of(Date.parse(AS_SYDNEY)));
  });

  it("decodes on a pinned connection", async () => {
    const { pool } = fakePool({ tc: 0 });
    const [rows, columns] = await new SybaseSession(pool, SYDNEY).withConnection(async conn => [
      (await conn.execute("select 1")).rows,
      (await conn.executeColumns("select 1")).columns
    ]);
    expect((rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_SYDNEY);
    expect(columns[0]!.values).toEqual(Float64Array.of(Date.parse(AS_SYDNEY)));
  });

  it.each([
    ["SybaseSession", (tz: string) => new SybaseSession(fakePool().pool, tz)],
    [
      "SybaseTransactionSession",
      (tz: string) => new SybaseTransactionSession(fakePool().conn, undefined, tz)
    ]
  ])("%s rejects an invalid zone at construction", (_name, construct) => {
    expect(() => construct("Not/AZone")).toThrow(/Invalid timeZone/);
  });
});

describe("createSybaseDrizzle timeZone wiring", () => {
  const winf = sybaseTable("WINF", {
    key: varchar("WINFkey", { length: 10 }).primaryKey(),
    dtRecAdded: datetime("dt_rec_added"),
    totPrRoyalty: money("tot_pr_royalty")
  });

  const instant = new Date(AS_SYDNEY);

  // A wrong zone here is invisible until a datetime crosses the wire, so it has
  // to fail while the connection is being set up.
  it("rejects an invalid zone before the pool is created", () => {
    expect(() => createSybaseDrizzle({ ...config, timeZone: "Not/AZone" })).toThrow(
      /Invalid timeZone/
    );
  });

  // `SybaseConnectionConfig.timeZone` documents that it is validated when the
  // connection is created, so every public entry point that accepts a config has
  // to honour that — not just the drizzle factory.
  it.each([
    ["SybasePool", (c: SybasePoolConfig) => new SybasePool(c)],
    ["SybaseConnection", (c: SybasePoolConfig) => new SybaseConnection(c)]
  ])("%s rejects an invalid zone at construction", (_name, construct) => {
    expect(() => construct({ ...config, timeZone: "Not/AZone" })).toThrow(/Invalid timeZone/);
  });

  it.each([
    ["SybasePool", (c: SybasePoolConfig) => new SybasePool(c)],
    ["SybaseConnection", (c: SybasePoolConfig) => new SybaseConnection(c)]
  ])("%s accepts a valid zone and an absent one", (_name, construct) => {
    expect(() => construct({ ...config, timeZone: SYDNEY })).not.toThrow();
    expect(() => construct(config)).not.toThrow();
  });

  it("renders Dates in the configured zone in insert values", () => {
    const db = createSybaseDrizzle({ ...config, timeZone: SYDNEY });
    const sql = db.insert(winf).values({ key: "W1", dtRecAdded: instant }).toSQL();
    expect(sql).toContain("'2016-06-09 09:48:46.753'");
  });

  it("renders Dates in the configured zone in a where clause", () => {
    const db = createSybaseDrizzle({ ...config, timeZone: SYDNEY });
    const sql = db.select().from(winf).where(eq(winf.dtRecAdded, instant)).toSQL();
    expect(sql).toContain("'2016-06-09 09:48:46.753'");
  });

  it("defaults to UTC", () => {
    const db = createSybaseDrizzle(config);
    const sql = db.insert(winf).values({ key: "W1", dtRecAdded: instant }).toSQL();
    expect(sql).toContain("'2016-06-08 23:48:46.753'");
  });

  // Proves the codecs reach the builders through the same factory.
  it("still wraps exact numeric parameters", () => {
    const db = createSybaseDrizzle({ ...config, timeZone: SYDNEY });
    const sql = db.select().from(winf).where(eq(winf.totPrRoyalty, "1.5000")).toSQL();
    expect(sql).toContain("convert(money, '1.5000')");
  });

  // Every parameter is written into the SQL anyway: .inlineParams() would make
  // drizzle render it its own way instead (local-time Dates, no CONVERT), so it
  // is refused — at the top or nested in a condition.
  it("refuses .inlineParams()", () => {
    const db = createSybaseDrizzle({ ...config, timeZone: SYDNEY });
    // A fresh condition each time: inlineParams() marks the SQL it is called on.
    const cond = () => sql`${eq(winf.dtRecAdded, instant)}`;
    expect(() => db.select().from(winf).where(cond().inlineParams()).toSQL()).toThrow(
      /remove \.inlineParams\(\)/
    );
    expect(() =>
      db
        .select()
        .from(winf)
        .where(sql`${eq(winf.key, "W1")} and ${sql`1 = ${true}`.inlineParams()}`)
        .toSQL()
    ).toThrow(/remove \.inlineParams\(\)/);
    expect(db.select().from(winf).where(cond()).toSQL()).toContain("'2016-06-09 09:48:46.753'");
  });

  // Every way drizzle reaches a marked SQL is refused — they all end in the
  // one place it writes a parameter itself — and only those.
  it("refuses .inlineParams() wherever drizzle renders it, and only there", () => {
    const db = createSybaseDrizzle({ ...config, timeZone: SYDNEY });
    const marked = () => sql`1 = ${true}`.inlineParams();
    const where = (cond: SQL) => () => db.select().from(winf).where(cond).toSQL();
    let deep: SQL = marked();
    for (let i = 0; i < 70; i++) {
      deep = sql`${deep}`;
    }
    for (const render of [
      where(sql`${sql.param(marked())}`),
      where(sql`${sql.param(1, { mapToDriverValue: marked })}`),
      where(sql`${{ getSQL: marked }}`),
      where(deep),
      where(sql`exists ${new Subquery(marked(), {}, "s")}`)
    ]) {
      expect(render).toThrow(/remove \.inlineParams\(\)/);
    }
    // Only the alias is rendered: nothing of what it names is written.
    expect(where(sql`${marked().as("a")} = 1`)()).toContain("[a] = 1");
  });
});

describe("column mapping hooks", () => {
  // The write hook runs through the dialect, which has the column in hand.
  it("applies $mapToDriver on write", () => {
    const t = sybaseTable("T", {
      k: varchar("k", { length: 5 }).primaryKey(),
      amt: money("amt").$mapToDriver(v => (v as { toFixed: (n: number) => string }).toFixed(4))
    });
    const db = createSybaseDrizzle(config);
    const sql = db
      .insert(t)
      .values({ k: "a", amt: { toFixed: (n: number) => (1.5).toFixed(n) } })
      .toSQL();
    expect(sql).toContain("convert(money, '1.5000')");
  });

  // There is no read-side hook: results are decoded from the addon's type
  // metadata, by which point the query's schema is gone. A hook that applied to
  // some shapes and not others would reintroduce a result type that depends on
  // how the query was written.
  it("exposes no $mapFromDriver to promise read-side mapping it cannot keep", () => {
    const builder = money("amt") as unknown as Record<string, unknown>;
    expect(builder.$mapFromDriver).toBeUndefined();
    expect(Object.keys(money("amt").build({}))).not.toContain("mapFromDriverValue");
  });
});

describe("query surface", () => {
  /**
   * The top-level handle and the transaction handle are built from one
   * definition, typed as `SybaseDrizzleTx`, so `tsc` is what guarantees they
   * cannot drift apart. This checks the runtime half: that spreading that
   * definition really does put every member on the handle.
   */
  it("puts the whole shared query surface on the top-level handle", () => {
    const db = createSybaseDrizzle(config) as unknown as Record<string, unknown>;
    for (const m of ["select", "insert", "update", "delete", "execute", "exec", "executeRaw"]) {
      expect(typeof db[m], m).toBe("function");
    }
  });

  // `exec` used to delegate through `this`, which broke when destructured.
  it("keeps exec working when detached from the handle", async () => {
    const db = createSybaseDrizzle(config);
    const query = vi
      .spyOn(SybasePool.prototype, "query")
      .mockResolvedValue(result({ rows: [{ x: 1 }], rowCount: 1 }));
    try {
      const { exec } = db;
      const answer = await exec(sql`exec some_proc`);
      expect(answer.rows).toEqual([{ x: 1 }]);
      expect(query).toHaveBeenCalledWith("exec some_proc", expect.anything());
    } finally {
      query.mockRestore();
    }
  });

  // Drizzle's max()/min() use the column as its decoder, as does
  // mapWith(column): a column must be one.
  it("selects max() and min() of a column, and a sql field mapped with a column", async () => {
    const db = createSybaseDrizzle(config);
    const t = sybaseTable("T", { k: varchar("k", { length: 5 }).primaryKey() });
    const query = vi
      .spyOn(SybasePool.prototype, "query")
      .mockResolvedValue(result({ rows: [{ hi: "b", lo: "a", m: "c" }], rowCount: 1 }));
    try {
      const rows = await db
        .select({ hi: max(t.k), lo: min(t.k), m: sql`'c'`.mapWith(getColumns(t).k) })
        .from(t);
      expect(rows).toEqual([{ hi: "b", lo: "a", m: "c" }]);
      expect(query.mock.calls[0]![0]).toMatch(/max\(\[T\]\.\[k\]\)/);
    } finally {
      query.mockRestore();
    }
  });

  // Assigned, a column keyed `__proto__` would set the prototype instead.
  it("keeps a column keyed __proto__ as a column", () => {
    const db = createSybaseDrizzle(config);
    const key = "__proto__";
    const t = sybaseTable("T", {
      k: varchar("k", { length: 5 }),
      [key]: varchar("p", { length: 5 })
    });
    const columns: Record<string, unknown> = getColumns(t);
    expect(Object.keys(columns)).toEqual(["k", key]);
    expect(Object.getPrototypeOf(t)).not.toBe(columns[key]);
    expect(db.select().from(t).toSQL()).toMatch(/\[p\] as \[__proto__\]/);
  });

  it("sets a column to another column's value", () => {
    const db = createSybaseDrizzle(config);
    const t = sybaseTable("T", {
      k: varchar("k", { length: 5 }).primaryKey(),
      a: varchar("a", { length: 5 }),
      b: varchar("b", { length: 5 })
    });
    expect(db.update(t).set({ a: t.b }).where(eq(t.k, "x")).toSQL()).toMatch(
      /set \[a\] = \[T\]\.\[b\]/i
    );
  });

  it("keeps insert working when detached from the handle", () => {
    const db = createSybaseDrizzle(config);
    const t = sybaseTable("T", { k: varchar("k", { length: 5 }).primaryKey() });
    const { insert } = db;
    expect(() => insert(t).values({ k: "a" }).toSQL()).not.toThrow();
  });

  // As Drizzle does: a sql field's mapWith() decoder applies to its values.
  it("applies the decoder a selected sql field was given with mapWith", async () => {
    const db = createSybaseDrizzle(config);
    const t = sybaseTable("T", { k: varchar("k", { length: 5 }).primaryKey() });
    const query = vi.spyOn(SybasePool.prototype, "query").mockResolvedValue(
      result({
        rows: [
          { amount: "1.5000", plain: "2.5000", aliased: "3" },
          { amount: null, plain: null, aliased: null }
        ],
        rowCount: 2
      })
    );
    try {
      const rows = await db
        .select({
          amount: sql<number>`convert(money, '1.5')`.mapWith(Number),
          plain: sql<string>`convert(money, '2.5')`,
          aliased: sql`3`.mapWith(v => `#${String(v)}`).as("aliased")
        })
        .from(t);
      expect(rows).toEqual([
        { amount: 1.5, plain: "2.5000", aliased: "#3" },
        { amount: null, plain: null, aliased: null }
      ]);
    } finally {
      query.mockRestore();
    }
  });
});

describe("transaction begin", () => {
  // BEGIN may have run on the server even though its result never arrived.
  it("rolls back what a failed BEGIN may have begun before releasing the connection", async () => {
    const { pool, conn, executed } = fakePool();
    Object.assign(conn, {
      query: async (sql: string) => {
        executed.push(sql);
        if (sql.includes("BEGIN TRAN")) {
          throw new Error("Could not hand the query result to JavaScript");
        }
        return serverVar(sql) ?? result();
      }
    });
    await expect(new SybaseSession(pool).transaction(async () => "x")).rejects.toThrow(
      /hand the query result/
    );
    expect(executed).toContain("if @@trancount > 0 rollback tran");
  });
});

describe("withConnection executeAtomic", () => {
  // Once a ROLLBACK or COMMIT runs, the rest of the batch runs in autocommit:
  // refused before anything is sent, as in db.transaction().
  it.each(["rollback tran\ninsert t values (1)", "insert t values (1)\ncommit"])(
    "refuses %j before sending it",
    async sql => {
      const { pool, executed } = fakePool();
      await expect(
        new SybaseSession(pool).withConnection(c => c.executeAtomic(sql))
      ).rejects.toThrow(/COMMIT and ROLLBACK cannot run inside executeAtomic/);
      expect(executed.filter(q => q.includes("insert t"))).toEqual([]);
    }
  );

  // Under a savepoint of an open transaction, a procedure that ends that
  // transaction leaves the rest of the batch committed on its own.
  it("fails when a procedure ends the enclosing transaction", async () => {
    const { pool, conn, executed } = fakePool();
    let tc = 1;
    Object.assign(conn, {
      query: async (sql: string) => {
        executed.push(sql);
        if (sql.startsWith("exec")) {
          tc = 0;
        }
        return serverVar(sql, { tc }) ?? result();
      }
    });
    await expect(
      new SybaseSession(pool).withConnection(c => c.executeAtomic("exec ends_tran"))
    ).rejects.toThrow(/ended the transaction it ran in/);
  });
});

describe("withConnection cleanup", () => {
  // Closing the connection rolls back what the callback left uncommitted: its
  // success cannot be reported when the state could not be checked.
  it("fails when the session's state cannot be checked after the callback", async () => {
    const { pool, conn } = fakePool();
    Object.assign(conn, {
      resetSessionState: async () => {
        throw new Error("connection lost");
      }
    });
    let closed = false;
    Object.assign(conn, { close: () => (closed = true) });
    await expect(
      new SybaseSession(pool).withConnection(async c => {
        await c.executeRaw("begin tran insert t values (1)");
        return "done";
      })
    ).rejects.toThrow(/state could not be checked/);
    expect(closed).toBe(true);
  });

  // Gone without the callback being told: what it left uncommitted is lost.
  it("fails when the connection was lost without the callback being told", async () => {
    const { pool, conn } = fakePool();
    await expect(
      new SybaseSession(pool).withConnection(async c => {
        await c.executeRaw("begin tran insert t values (1)");
        Object.assign(conn, { isConnected: false });
        return "done";
      })
    ).rejects.toThrow(/state could not be checked/);
  });

  // A call that failed as the connection went does not say the callback knew
  // what was lost: the error may be another one, or come after it returned.
  it("fails after a lost connection even when the callback caught the error", async () => {
    const { pool, conn } = fakePool();
    Object.assign(conn, {
      query: async () => {
        Object.assign(conn, { isConnected: false });
        throw new Error("connection lost");
      }
    });
    await expect(
      new SybaseSession(pool).withConnection(async c =>
        c.executeRaw("select 1").catch(() => "handled")
      )
    ).rejects.toThrow(/state could not be checked/);
  });

  it("fails when a call left running fails after the callback returned", async () => {
    const { pool, conn } = fakePool();
    let fail!: () => void;
    Object.assign(conn, {
      query: () =>
        new Promise((_, reject) => {
          fail = () => {
            Object.assign(conn, { isConnected: false });
            reject(new Error("connection lost"));
          };
        })
    });
    const done = new SybaseSession(pool).withConnection(async c => {
      c.executeRaw("insert t values (1)").catch(() => {});
      return "done";
    });
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    fail();
    await expect(done).rejects.toThrow(/state could not be checked/);
  });
});

describe("transaction session state", () => {
  // Session state is reset where it can go wrong (a failed statement), so a
  // transaction that succeeds pays no extra round-trip for cleanup.
  it("sends nothing beyond BEGIN, the statements and COMMIT", async () => {
    const { pool, executed } = fakePool();
    await new SybaseSession(pool).transaction(async tx => {
      await tx.execute("select 1");
    });
    expect(executed).toHaveLength(3);
    expect(executed.slice(0, 2)).toEqual(["BEGIN TRAN", "select 1"]);
    expect(executed[2]).toMatch(/^if @@trancount = 1 commit tran\b/);
  });

  it("sets the isolation level with BEGIN and resets the session before releasing", async () => {
    const { pool, executed } = fakePool();
    await new SybaseSession(pool).transaction(async () => {}, { isolationLevel: "serializable" });
    expect(executed).toHaveLength(3);
    expect(executed[0]).toBe("SET TRANSACTION ISOLATION LEVEL 3\nBEGIN TRAN");
    expect(executed[1]).toMatch(/commit tran/);
    expect(executed[2]).toBe("RESET");
  });

  // ROWCOUNT, the isolation level and the like outlive the transaction.
  it("resets the session when a statement may have changed its state", async () => {
    const { pool, executed } = fakePool();
    await new SybaseSession(pool).transaction(async tx => {
      await tx.execute("set rowcount 5");
    });
    expect(executed.at(-1)).toBe("RESET");
  });

  it("does not reset after statements that cannot change session state", async () => {
    const { pool, executed } = fakePool();
    await new SybaseSession(pool).transaction(async tx => {
      await tx.execute("select top 10 * from [t]");
      await tx.execute("insert into [t] ([a]) values (1)");
      await tx.executeAtomic("insert into [t] ([a]) values (1)\ninsert into [t] ([a]) values (2)");
    });
    expect(executed).not.toContain("RESET");
  });

  it("discards the connection when the reset fails", async () => {
    let closed = false;
    const conn = {
      get isConnected() {
        return !closed;
      },
      query: async (sql: string) => serverVar(sql) ?? result(),
      resetSessionState: async () => {
        throw new Error("reset failed");
      },
      close: () => {
        closed = true;
      }
    } as unknown as SybaseConnection;
    const released: SybaseConnection[] = [];
    const pool = {
      logger: undefined,
      acquire: async () => conn,
      release: (c: SybaseConnection) => released.push(c)
    } as unknown as SybasePool;
    await new SybaseSession(pool).transaction(async () => {}, { isolationLevel: "serializable" });
    expect(closed).toBe(true);
    expect(released).toEqual([conn]);
  });

  it("does not let a throwing logger fail a transaction statement", async () => {
    const { conn } = fakePool();
    const logger = {
      query() {
        throw new Error("logger broke");
      }
    };
    await expect(
      new SybaseTransactionSession(conn, logger).execute("select 1")
    ).resolves.toBeDefined();
  });
});

describe("transaction cleanup failures", () => {
  /** Connection that stays "alive" but fails the given statement. */
  const failing = (failSql: string) => {
    let closed = false;
    const conn = {
      get isConnected() {
        return !closed;
      },
      query: async (sql: string) => {
        if (sql === failSql || sql.startsWith(failSql)) {
          throw new Error(`${failSql} failed`);
        }
        return serverVar(sql) ?? result();
      },
      close: () => {
        closed = true;
      }
    } as unknown as SybaseConnection;
    const released: SybaseConnection[] = [];
    const pool = {
      logger: undefined,
      acquire: async () => conn,
      release: (c: SybaseConnection) => released.push(c)
    } as unknown as SybasePool;
    return { pool, conn, released };
  };

  // An alive socket says nothing about @@trancount: a connection whose rollback
  // failed may still hold the open transaction and must not be reused.
  it("discards the connection when ROLLBACK fails", async () => {
    const { pool, conn, released } = failing("ROLLBACK TRAN");
    await expect(
      new SybaseSession(pool).transaction(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(released).toEqual([conn]);
    expect(conn.isConnected).toBe(false);
  });
});

describe("transaction statement failure", () => {
  const conn = (fail: (sql: string) => boolean) => {
    const executed: string[] = [];
    let closed = false;
    const c = {
      get isConnected() {
        return !closed;
      },
      query: async (sql: string) => {
        executed.push(sql);
        if (fail(sql)) {
          throw new Error(`failed: ${sql}`);
        }
        return serverVar(sql) ?? result();
      },
      close: () => {
        closed = true;
      }
    } as unknown as SybaseConnection;
    return { c, executed };
  };

  // The caller may catch the error and continue; a skipped trailing
  // `SET ROWCOUNT 0` would otherwise truncate every later statement.
  it("resets ROWCOUNT before rethrowing a failed statement", async () => {
    const { c, executed } = conn(sql => sql.includes("1/0"));
    const tx = new SybaseTransactionSession(c);
    await expect(tx.execute("SET ROWCOUNT 1\nselect 1/0\nSET ROWCOUNT 0")).rejects.toThrow(
      "failed"
    );
    expect(executed.at(-1)).toBe("SET ROWCOUNT 0\nselect @@trancount as tc");
    expect(c.isConnected).toBe(true);
  });

  /** Connection whose failing statement makes the server roll the transaction back. */
  const abortingConn = () => {
    const executed: string[] = [];
    let trancount = 1;
    const c = {
      isConnected: true,
      query: async (sql: string) => {
        executed.push(sql);
        if (sql.includes("convert(int, 'x')")) {
          trancount = 0;
          throw new Error("Msg 249");
        }
        if (sql.includes("@@trancount as tc")) {
          return result({ rows: [{ tc: trancount }], columns: ["tc"], columnTypes: ["int"] });
        }
        return result();
      },
      close: () => {}
    } as unknown as SybaseConnection;
    return { c, executed };
  };

  // ASE rolls the whole transaction back on e.g. a conversion error. Later
  // statements would run in autocommit mode, outside the caller's transaction.
  it("refuses further statements once the server has rolled the transaction back", async () => {
    const { c, executed } = abortingConn();
    const tx = new SybaseTransactionSession(c);
    await expect(tx.execute("select convert(int, 'x')")).rejects.toThrow("Msg 249");
    expect(tx.aborted).toBe(true);
    await expect(tx.execute("insert into t values (1)")).rejects.toThrow(
      /rolled back by the server/
    );
    expect(executed).not.toContain("insert into t values (1)");
  });

  // Queued behind the failure, the second statement would otherwise reach the
  // server after its rollback and commit on its own.
  it("refuses a concurrent statement queued behind the aborting one", async () => {
    const { c, executed } = abortingConn();
    const tx = new SybaseTransactionSession(c);
    const [first, second] = await Promise.allSettled([
      tx.execute("select convert(int, 'x')"),
      tx.execute("insert into t values (2)")
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason.message).toMatch(/rolled back by the server/);
    expect(executed).not.toContain("insert into t values (2)");
  });

  // A statement started without being awaited must not run after COMMIT.
  it("waits for an in-flight statement before committing", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const c = {
      isConnected: true,
      query: async (sql: string) => {
        if (sql === "select 'slow'") {
          await gate;
        }
        order.push(sql);
        return serverVar(sql) ?? result();
      }
    } as unknown as SybaseConnection;
    const pool = {
      logger: undefined,
      acquire: async () => c,
      release: () => {}
    } as unknown as SybasePool;
    let refused: unknown;
    const done = new SybaseSession(pool).transaction(async tx => {
      void tx.execute("select 'slow'");
      tx.execute("select 'never'").catch(err => (refused = err));
    });
    setTimeout(release, 10);
    await done;
    expect(order[0]).toBe("BEGIN TRAN");
    expect(order[1]).toBe("select 'slow'");
    expect(order[2]).toMatch(/commit tran/);
    expect(order).not.toContain("select 'never'");
    expect(String(refused)).toMatch(/already ended/);
  });

  it("does not commit when the callback swallowed an aborting error", async () => {
    const { c, executed } = abortingConn();
    const pool = {
      logger: undefined,
      acquire: async () => c,
      release: () => {}
    } as unknown as SybasePool;
    await expect(
      new SybaseSession(pool).transaction(async tx => {
        await tx.execute("select convert(int, 'x')").catch(() => {});
      })
    ).rejects.toThrow(/rolled back by the server/);
    expect(executed.some(s => s.includes("commit tran"))).toBe(false);
  });

  it("keeps the transaction usable after an error that did not abort it", async () => {
    const { c } = conn(sql => sql === "select 1/0");
    const tx = new SybaseTransactionSession(c);
    await expect(tx.execute("select 1/0")).rejects.toThrow();
    expect(tx.aborted).toBe(false);
    await expect(tx.execute("select 1")).resolves.toBeDefined();
  });

  it("executeAtomic rolls back to its own savepoint on failure", async () => {
    const { c, executed } = conn(sql => sql.startsWith("insert"));
    const tx = new SybaseTransactionSession(c);
    await expect(tx.executeAtomic("insert into t values (1)")).rejects.toThrow();
    expect(executed[0]).toBe("save tran drizzle_sybase_sp_1");
    expect(executed.at(-1)).toBe("rollback tran drizzle_sybase_sp_1");
    expect(c.isConnected).toBe(true);
  });

  // Interleaved, B's savepoint would be taken before A's batch ran, and A's
  // rollback would undo B's work after B had reported success.
  it("runs concurrent executeAtomic calls one whole operation at a time", async () => {
    const { c, executed } = conn(sql => sql.startsWith("insert a"));
    const tx = new SybaseTransactionSession(c);
    const [a, b] = await Promise.allSettled([
      tx.executeAtomic("insert a"),
      tx.executeAtomic("insert b")
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
    expect(executed).toEqual([
      "save tran drizzle_sybase_sp_1",
      "insert a",
      "SET ROWCOUNT 0\nselect @@trancount as tc",
      "rollback tran drizzle_sybase_sp_1",
      "save tran drizzle_sybase_sp_2",
      "insert b"
    ]);
  });

  it.each([
    ["no row", []],
    ["a non-integer", [{ tc: null }]],
    ["an empty string", [{ tc: "" }]]
  ])("closes the connection when @@trancount reads as %s", async (_n, rows) => {
    let closed = false;
    const c = {
      get isConnected() {
        return !closed;
      },
      query: async (sql: string) => {
        if (sql === "bad") {
          throw new Error("failed");
        }
        return result({ rows, columns: ["tc"], columnTypes: ["int"] });
      },
      close: () => {
        closed = true;
      }
    } as unknown as SybaseConnection;
    const tx = new SybaseTransactionSession(c);
    await expect(tx.execute("bad")).rejects.toThrow("failed");
    expect(closed).toBe(true);
  });

  it("closes the connection when that reset fails, keeping the original error", async () => {
    const { c } = conn(() => true);
    const tx = new SybaseTransactionSession(c);
    await expect(tx.execute("select 1/0")).rejects.toThrow("failed: select 1/0");
    expect(c.isConnected).toBe(false);
  });
});

describe("statements that end the transaction", () => {
  /** A connection whose @@trancount drops to 0 once `endsTran` runs. */
  const tracking = () => {
    const executed: string[] = [];
    let trancount = 0;
    let closed = false;
    const conn = {
      get isConnected() {
        return !closed;
      },
      query: async (sql: string) => {
        executed.push(sql);
        if (sql === "BEGIN TRAN" || sql.endsWith("\nBEGIN TRAN")) {
          trancount = 1;
        } else if (/^(commit tran|rollback tran|exec sp_ends_tran)$/.test(sql)) {
          trancount = 0;
        }
        return serverVar(sql, { tc: trancount }) ?? result();
      },
      resetSessionState: async () => ({ leftOpen: false }),
      close: () => {
        closed = true;
      }
    } as unknown as SybaseConnection;
    const pool = {
      logger: undefined,
      acquire: async () => conn,
      release: () => {}
    } as unknown as SybasePool;
    return { pool, conn, executed, isClosed: () => closed };
  };

  // The statement succeeds, so nothing else would notice: everything after it
  // would run in autocommit, beyond the reach of the final commit check.
  // Sent, a COMMIT/ROLLBACK would let the rest of its own batch run in
  // autocommit before anything could check — so it is never sent.
  it.each([
    "commit tran",
    "commit",
    "COMMIT WORK",
    "rollback tran",
    "rollback",
    "rollback transaction",
    "rollback work",
    "commit tran\ninsert into t values (2)",
    "rollback tran\nselect 1",
    "if 1 = 1 commit tran"
  ])("refuses %j before sending it", async statement => {
    const { pool, executed } = tracking();
    await new SybaseSession(pool).transaction(async tx => {
      await expect(tx.execute(statement)).rejects.toThrow(/cannot run inside db.transaction/);
      // Nothing ran, so the transaction carries on.
      await tx.execute("insert into t values (1)");
    });
    expect(executed).not.toContain(statement);
    expect(executed).toContain("insert into t values (1)");
    expect(executed.at(-1)).toMatch(/if @@trancount = 1 commit tran/);
  });

  it.each(["rollback tran sp1", "ROLLBACK TRANSACTION sp_2", "save tran sp1"])(
    "allows savepoint statement %j",
    async statement => {
      const { pool, executed } = tracking();
      await new SybaseSession(pool).transaction(async tx => {
        await tx.execute(statement);
      });
      expect(executed).toContain(statement);
    }
  );

  // A procedure that commits cannot be seen in the text: caught after it runs,
  // and nothing more is allowed to run.
  it("refuses to continue after a procedure ended the transaction, and does not commit", async () => {
    const { pool, executed } = tracking();
    let afterwards: unknown;
    await expect(
      new SybaseSession(pool).transaction(async tx => {
        await expect(tx.execute("exec sp_ends_tran")).rejects.toThrow(/ended by a statement/);
        afterwards = await tx.execute("insert into t values (1)").catch(err => err);
      })
    ).rejects.toThrow(/ended by a statement/);
    // Not "rolled back": the procedure may have committed what came before it.
    expect(String(afterwards)).toMatch(/may already be committed/);
    expect(executed).not.toContain("insert into t values (1)");
    expect(executed.some(s => s.includes("commit tran\n"))).toBe(false);
  });

  it("lets statements that keep it open continue (savepoints, procedures)", async () => {
    const { pool, executed } = tracking();
    await new SybaseSession(pool).transaction(async tx => {
      await tx.execute("save tran sp1");
      await tx.execute("exec sp_keeps_tran");
      await tx.execute("insert into t values (1)");
    });
    expect(executed).toContain("insert into t values (1)");
    expect(executed.at(-1)).toMatch(/if @@trancount = 1 commit tran/);
  });

  it("checks nothing extra after plain statements", async () => {
    const { pool, executed } = tracking();
    await new SybaseSession(pool).transaction(async tx => {
      await tx.execute("insert into t values (1)");
    });
    expect(executed.filter(s => s === "select @@trancount as tc")).toEqual([]);
  });

  // The identity cannot be switched back reliably, so the connection must not
  // be reused.
  it("discards the connection after setuser", async () => {
    const { pool, isClosed } = tracking();
    await new SybaseSession(pool).transaction(async tx => {
      await tx.execute("setuser 'app'");
    });
    expect(isClosed()).toBe(true);
  });
});

describe("transaction session lifetime", () => {
  // The connection goes back to the pool when the transaction ends; a kept
  // reference to the old `tx` must not run on it inside someone else's
  // transaction.
  it("rejects statements on a transaction that has already committed", async () => {
    const { pool, executed } = fakePool();
    const session = new SybaseSession(pool);
    let stale!: SybaseTransactionSession;
    await session.transaction(async tx => {
      stale = tx;
    });

    await session.transaction(async () => {
      await expect(stale.execute("select 123 as escaped")).rejects.toThrow(/already ended/);
    });
    expect(executed).not.toContain("select 123 as escaped");
  });

  it("rejects statements on a transaction that has rolled back", async () => {
    const { pool } = fakePool();
    let stale!: SybaseTransactionSession;
    await expect(
      new SybaseSession(pool).transaction(async tx => {
        stale = tx;
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(stale.executeRaw("select 1")).rejects.toThrow(/already ended/);
  });
});
