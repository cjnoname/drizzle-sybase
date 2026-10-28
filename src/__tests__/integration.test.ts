/**
 * Integration test — requires real Sybase connection.
 *
 * Set environment variables to run:
 *   SYBASE_HOST, SYBASE_PORT, SYBASE_DATABASE, SYBASE_USERNAME, SYBASE_PASSWORD
 *
 * Or create a .env.test file (not committed to git).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, sql } from "drizzle-orm";
import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

import {
  bigdatetime,
  bigint,
  bigtime,
  binary,
  bit,
  char,
  date,
  datetime,
  float,
  image,
  int,
  money,
  nchar,
  numeric,
  nvarchar,
  real,
  smalldatetime,
  smallint,
  smallmoney,
  text,
  time,
  tinyint,
  unichar,
  unitext,
  univarchar,
  unsignedBigint,
  unsignedInt,
  unsignedSmallint,
  varbinary,
  varchar
} from "../columns/index.js";
import { SybaseConnection } from "../connection.js";
import { describeTimeZoneMismatch } from "../datetime.js";
import { createSybaseDrizzle } from "../db.js";
import { serializeValue } from "../dialect.js";
import { SYBASE_TYPE_MAP, type ValueKind } from "../introspect/type-map.js";
import { native } from "../native/index.js";
import { SybasePool } from "../pool.js";
import { SybaseSession } from "../session.js";
import type { SybaseConnectionSession } from "../session.js";
import { sybaseTable } from "../table.js";

const config = {
  host: process.env.SYBASE_HOST ?? "",
  port: Number(process.env.SYBASE_PORT ?? "5000"),
  database: process.env.SYBASE_DATABASE ?? "",
  username: process.env.SYBASE_USERNAME ?? "",
  password: process.env.SYBASE_PASSWORD ?? ""
};

const hasConfig = config.host && config.database && config.username;

describe.skipIf(!hasConfig)("native binding (real connection)", () => {
  let conn: unknown;

  afterAll(() => {
    if (conn) {
      native.close(conn);
    }
  });

  it("connects to Sybase ASE", async () => {
    conn = await native.connect(config);
    expect(conn).toBeDefined();
  });

  it("executes simple query", async () => {
    const result = await native.query(conn, "SELECT 1 AS test");
    expect(result.rows).toEqual([{ test: 1 }]);
    expect(result.rowCount).toBe(1);
  });

  it("handles SET ROWCOUNT batch", async () => {
    const result = await native.query(
      conn,
      "SET ROWCOUNT 3\nSELECT name FROM sysobjects ORDER BY name\nSET ROWCOUNT 0"
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toHaveProperty("name");
  });

  it("maps int types to number", async () => {
    const result = await native.query(conn, "SELECT 42 AS val");
    expect(result.rows[0].val).toBe(42);
    expect(typeof result.rows[0].val).toBe("number");
  });

  it("maps float types to number", async () => {
    const result = await native.query(conn, "SELECT CONVERT(float, 3.14) AS val");
    expect(typeof result.rows[0].val).toBe("number");
    expect(result.rows[0].val).toBeCloseTo(3.14);
  });

  it("keeps strings as strings", async () => {
    const result = await native.query(conn, "SELECT 'hello' AS val");
    expect(result.rows[0].val).toBe("hello");
  });

  it("handles NULL values", async () => {
    const result = await native.query(conn, "SELECT NULL AS val");
    expect(result.rows[0].val).toBeNull();
  });

  // Binary columns used to come back as hex text ("deadbeef"), unlike the
  // Buffer the schema declares and a write of the same value takes.
  it("returns binary columns as Buffer with the exact bytes", async () => {
    const result = await native.query(
      conn,
      "SELECT CONVERT(varbinary(4), 0xdeadbeef) AS b, CONVERT(varbinary(3), 0x00ff00) AS z, " +
        "CONVERT(varbinary(4), NULL) AS n"
    );
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.b).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(row.z).toEqual(Buffer.from([0x00, 0xff, 0x00]));
    expect(row.n).toBeNull();
  });

  // Runtime errors arrive after the column metadata and abort the batch
  // without dbresults() returning FAIL; they must still reject the query.
  it("rejects a runtime error raised after the result columns", async () => {
    await expect(native.query(conn, "SELECT 1/0 AS val")).rejects.toThrow(/Msg 3607/);
    await expect(
      native.query(conn, "SELECT CONVERT(int, name) AS val FROM sysobjects WHERE type = 'S'")
    ).rejects.toThrow(/Msg 249/);
  });

  it("rejects a batch whose later statement fails after an earlier one succeeded", async () => {
    await expect(native.query(conn, "SELECT 1 AS a\nSELECT 1/0 AS b")).rejects.toThrow(/Msg 3607/);
  });

  it("stays usable after a runtime error", async () => {
    const result = await native.query(conn, "SET ROWCOUNT 0\nSELECT 1 AS ok");
    expect(result.rows).toEqual([{ ok: 1 }]);
  });

  it("handles sequential queries on same connection", async () => {
    const r1 = await native.query(conn, "SELECT 1 AS a");
    const r2 = await native.query(conn, "SELECT 2 AS b");
    const r3 = await native.query(conn, "SELECT 3 AS c");
    expect(r1.rows[0].a).toBe(1);
    expect(r2.rows[0].b).toBe(2);
    expect(r3.rows[0].c).toBe(3);
  });
});

/**
 * Prelude for a child script that imports the TypeScript sources directly: Node
 * strips the types, but the sources import each other as `.js`, as compiled.
 */
const RESOLVE_TS = `
  import { registerHooks } from "node:module";
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (err) {
        if (!specifier.startsWith(".") || !specifier.endsWith(".js")) throw err;
        return next(specifier.slice(0, -3) + ".ts", context);
      }
    }
  });
`;

describe.skipIf(!hasConfig)("native close while a query is queued", () => {
  // With a single libuv worker busy, the second query waits in the queue.
  // Closing its connection then used to free the struct the queued worker
  // was about to use — the process aborted. Run in a child so a regression
  // cannot take the test runner down with it.
  it("rejects the queued query instead of crashing the process", () => {
    const nativeUrl = new URL("../native/index.ts", import.meta.url).href;
    const script = `${RESOLVE_TS}
      const { native } = await import(${JSON.stringify(nativeUrl)});
      const cfg = JSON.parse(process.env.CFG);
      const a = await native.connect(cfg);
      const b = await native.connect(cfg);
      const busy = native.query(a, "waitfor delay '00:00:01'\\nselect 1 as x");
      const queued = native.query(b, "select 2 as y");
      native.close(b);
      const [r1, r2] = await Promise.allSettled([busy, queued]);
      native.close(a);
      console.log(JSON.stringify([r1.status, r2.status, r2.reason?.message]));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, UV_THREADPOOL_SIZE: "1", CFG: JSON.stringify(config) },
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 60_000
    });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split("\n").at(-1)!)).toEqual([
      "fulfilled",
      "rejected",
      "Connection is closed"
    ]);
  }, 70_000);

  // The handle outlives the connection: before, a second close or any use of
  // the handle after close read freed memory. Run in a child, as above.
  it("keeps a closed handle safe to close, check and query", () => {
    const nativeUrl = new URL("../native/index.ts", import.meta.url).href;
    const script = `${RESOLVE_TS}
      const { native } = await import(${JSON.stringify(nativeUrl)});
      const cfg = JSON.parse(process.env.CFG);
      const out = [];
      const h = await native.connect(cfg);
      native.close(h);
      native.close(h);
      out.push(native.isAlive(h));
      out.push(await native.query(h, "select 1").then(() => "resolved", e => e.message));
      // Never closed: the GC finalizer must release it cleanly.
      let leaked = await native.connect(cfg);
      await native.query(leaked, "select 1");
      leaked = null;
      for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise(r => setTimeout(r, 20)); }
      out.push("gc ok");
      console.log(JSON.stringify(out));
    `;
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=module", "-e", script],
      {
        env: { ...process.env, CFG: JSON.stringify(config) },
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
        timeout: 60_000
      }
    );

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split("\n").at(-1)!)).toEqual([
      false,
      "Connection is closed",
      "gc ok"
    ]);
  }, 70_000);

  // Rows past the internal cap used to be dropped and the rest returned as if
  // it were the whole result.
  it("fails a result past the internal row cap unless maxRows asks for it", async () => {
    const h = await native.connect({ ...config, timeout: 120 });
    try {
      // A triple cross join of a system catalog: past the cap on any database.
      const big = "select top 1000001 a.id from syscolumns a, syscolumns b, syscolumns c";
      await expect(native.query(h, big)).rejects.toThrow(/exceeded 1000000 rows/);
      expect((await native.query(h, big, { maxRows: 10 })).rows).toHaveLength(10);
      expect((await native.query(h, "select 1 as v")).rows).toEqual([{ v: 1 }]);
    } finally {
      native.close(h);
    }
  }, 120_000);
});

describe.skipIf(!hasConfig)("batch and transaction atomicity", () => {
  // In tempdb, never the configured (possibly real) database; not a #temp
  // table, which would be dropped after each pool query.
  const atom = `tempdb..drz_atom_${process.pid}`;
  let pool: SybasePool;
  let session: SybaseSession;
  const ins = (...vs: number[]) =>
    vs.map(v => `insert into ${atom} (v) values (${v})`).join("\n") + "\nSELECT @@identity";
  const values = async () =>
    (await session.execute<{ v: number }>(`select v from ${atom} order by v`)).rows.map(r => r.v);

  beforeAll(async () => {
    pool = new SybasePool({ ...config, max: 1 });
    session = new SybaseSession(pool);
    await session.execute(
      `if object_id('${atom}') is not null drop table ${atom}\n` +
        `create table ${atom} (id numeric(10,0) identity, v int not null, unique (v))`
    );
  });

  beforeEach(async () => {
    await session.execute(`delete from ${atom}\ninsert into ${atom} (v) values (100)`);
  });

  afterAll(async () => {
    await session?.execute(`drop table ${atom}`);
    await pool?.close();
  });

  // ASE carries on after a duplicate key; the rows around it must not stay.
  it("applies none of a multi-row batch when one row fails", async () => {
    await expect(session.executeAtomic(ins(1, 100, 3))).rejects.toThrow(/Msg 2601/);
    expect(await values()).toEqual([100]);
  });

  // The native layer used to leave the rest of the batch unread, so the next
  // statement on the connection failed with DB-Lib 20019.
  it("leaves the connection usable after a statement error mid-batch", async () => {
    await expect(session.execute(ins(1, 100, 3))).rejects.toThrow(/Msg 2601/);
    await expect(session.execute("select 1 as v")).resolves.toMatchObject({ rows: [{ v: 1 }] });
    expect(pool.metrics.totalConnectionsCreated).toBe(1);
  });

  it("undoes only the failed batch inside a transaction", async () => {
    await session.transaction(async tx => {
      await tx.execute(ins(1));
      await expect(tx.executeAtomic(ins(2, 100, 3))).rejects.toThrow(/Msg 2601/);
      expect(tx.aborted).toBe(false);
    });
    expect(await values()).toEqual([1, 100]);
  });

  it("keeps concurrent executeAtomic calls from undoing each other", async () => {
    const outcome = await session.transaction(async tx =>
      (
        await Promise.allSettled([tx.executeAtomic(ins(10, 100)), tx.executeAtomic(ins(20, 21))])
      ).map(r => r.status)
    );
    expect(outcome).toEqual(["rejected", "fulfilled"]);
    expect(await values()).toEqual([20, 21, 100]);
  });

  it("does not let a concurrent statement escape a server-side rollback", async () => {
    await expect(
      session.transaction(async tx => {
        await Promise.allSettled([
          tx.execute(`${ins(1)}\nselect convert(int, 'x')`),
          tx.execute(ins(2))
        ]);
      })
    ).rejects.toThrow(/rolled back by the server/);
    expect(await values()).toEqual([100]);
  });

  it("refuses a raw COMMIT, and a nested BEGIN left open", async () => {
    await expect(
      session.transaction(async tx => {
        await tx.execute("commit tran");
      })
    ).rejects.toThrow(/cannot run inside db.transaction/);
    await expect(
      session.transaction(async tx => {
        await tx.execute("begin tran");
        await tx.execute(ins(40));
      })
    ).rejects.toThrow(/Msg 20000/);
    expect(await values()).toEqual([100]);
    expect((await session.execute("select @@trancount as tc")).rows).toEqual([{ tc: 0 }]);
  });

  // Sent, `commit tran` would commit row 1 and then run row 2's insert in
  // autocommit, both kept even if the transaction then failed — reproduced
  // before this was refused. Refused unsent, the transaction is intact.
  it("never sends a COMMIT, even mid-batch: the transaction stays whole", async () => {
    await expect(
      session.transaction(async tx => {
        await tx.execute(ins(1));
        await expect(tx.execute(`commit tran\n${ins(2)}`)).rejects.toThrow(
          /cannot run inside db.transaction/
        );
        throw new Error("abandon");
      })
    ).rejects.toThrow("abandon");
    expect(await values()).toEqual([100]);
    expect((await session.execute("select @@trancount as tc")).rows).toEqual([{ tc: 0 }]);
  });

  it("allows rolling back to a savepoint", async () => {
    await session.transaction(async tx => {
      await tx.execute(ins(1));
      await tx.execute("save tran sp1");
      await tx.execute(ins(2));
      await tx.execute("rollback tran sp1");
    });
    expect(await values()).toEqual([1, 100]);
  });

  it("rolls back a transaction a failed raw batch left open", async () => {
    await expect(session.execute(`begin tran\n${ins(100)}`)).rejects.toThrow(/Msg 2601/);
    expect((await session.execute("select @@trancount as tc")).rows).toEqual([{ tc: 0 }]);
  });

  // Nothing could ever commit it: the next pool query may run elsewhere.
  it("rolls back and reports a transaction a successful raw batch left open", async () => {
    await expect(session.execute(`begin tran\n${ins(1)}`)).rejects.toThrow(
      /left a transaction open/
    );
    expect((await session.execute("select @@trancount as tc")).rows).toEqual([{ tc: 0 }]);
    expect(await values()).toEqual([100]);
  });

  it("does not let raw session settings reach the next pool user", async () => {
    const database = (await session.execute<{ db: string }>("select db_name() as db")).rows[0]!.db;
    await session.execute("use tempdb");
    expect((await session.execute("select db_name() as db")).rows).toEqual([{ db: database }]);
    await session.execute("set rowcount 1");
    // The trailing reset is skipped by RETURN; text alone cannot tell.
    await session.execute("SET ROWCOUNT 1\nselect 1 as x\nreturn\nSET ROWCOUNT 0");
    await session.execute("set transaction isolation level 3");
    await expect(session.execute("set chained on")).rejects.toThrow(/chained mode/);
    await session.execute(`insert into ${atom} (v) values (1)`);
    expect(await values()).toEqual([1, 100]);
    expect(
      (await session.execute("select @@isolation as iso, @@tranchained as ch, @@trancount as tc"))
        .rows
    ).toEqual([{ iso: 1, ch: 0, tc: 0 }]);
  });

  it("restores the session after a transaction that changed it", async () => {
    await session.transaction(
      async tx => {
        await tx.execute("set rowcount 1");
      },
      { isolationLevel: "serializable" }
    );
    expect(await values()).toEqual([100]);
    await session.execute(`insert into ${atom} (v) values (1)`);
    expect(await values()).toEqual([1, 100]);
    expect((await session.execute("select @@isolation as iso")).rows).toEqual([{ iso: 1 }]);
  });

  const tempTables = async () =>
    (
      await session.execute<{ t: number | null; u: number | null }>(
        "select object_id('#drz_t') as t, object_id('#drz_u') as u"
      )
    ).rows[0];

  // Used to stay on the connection: the next user's `create table #drz_t` failed.
  it("drops the #temp tables a pool query created", async () => {
    await session.execute(
      "create table #drz_t (v int)\ninsert into #drz_t values (1)\nselect v into #drz_u from #drz_t"
    );
    expect(await tempTables()).toEqual({ t: null, u: null });
    await session.execute("create table #drz_t (v int)");
    expect(pool.metrics.totalConnectionsCreated).toBe(1);
  });

  it("drops them after a failed batch too", async () => {
    await expect(
      session.execute("create table #drz_t (v int)\nselect convert(int, 'x')")
    ).rejects.toThrow(/Msg 249/);
    expect(await tempTables()).toEqual({ t: null, u: null });
  });

  it("keeps #temp tables for the whole transaction, then drops them", async ({ skip }) => {
    await session.transaction(async tx => {
      // Only where `ddl in tran` is enabled (it is not on every server).
      const created = await tx.execute("create table #drz_t (v int)").catch((err: unknown) => {
        if (err instanceof Error && /Msg 2762/.test(err.message)) {
          return undefined;
        }
        throw err;
      });
      if (!created) {
        skip();
      }
      await tx.execute("insert into #drz_t values (1)");
      expect((await tx.execute("select v from #drz_t")).rows).toEqual([{ v: 1 }]);
    });
    expect(await tempTables()).toEqual({ t: null, u: null });
  });

  // A drop inside the open transaction would be undone by the rollback.
  it("drops one created before a transaction the batch left open", async () => {
    await expect(
      session.execute(`create table #drz_t (v int)\nbegin tran\n${ins(1)}`)
    ).rejects.toThrow(/left a transaction open/);
    expect(await tempTables()).toEqual({ t: null, u: null });
    expect(await values()).toEqual([100]);
  });

  it("keeps #temp tables across statements in withConnection(), then drops them", async () => {
    const rows = await session.withConnection(async c => {
      await c.execute("create table #drz_t (v int)");
      await c.execute("insert into #drz_t values (1)");
      await c.executeAtomic("insert into #drz_t values (2)\ninsert into #drz_t values (3)");
      return (await c.execute<{ v: number }>("select v from #drz_t order by v")).rows;
    });
    expect(rows).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
    expect(await tempTables()).toEqual({ t: null, u: null });
  });

  it("undoes a failed executeAtomic batch in withConnection()", async () => {
    await session.withConnection(async c => {
      await expect(c.executeAtomic(ins(1, 100, 3))).rejects.toThrow(/Msg 2601/);
      expect((await c.execute("select @@trancount as tc")).rows).toEqual([{ tc: 0 }]);
    });
    expect(await values()).toEqual([100]);
  });

  it("rolls back and reports a transaction withConnection() left open", async () => {
    await expect(
      session.withConnection(async c => {
        await c.execute(`begin tran\n${ins(1)}`);
      })
    ).rejects.toThrow(/left a transaction open/);
    expect(await values()).toEqual([100]);
  });

  it("refuses statements after withConnection() has returned", async () => {
    let kept!: SybaseConnectionSession;
    await session.withConnection(async c => {
      kept = c;
    });
    await expect(kept.execute("select 1")).rejects.toThrow(/has ended/);
  });

  it("leaves other sessions' #temp tables alone", async () => {
    const other = new SybasePool({ ...config, max: 1 });
    try {
      const conn = await other.acquire();
      try {
        await conn.query("create table #drz_t (v int)");
        await session.execute("create table #drz_t (v int)");
        expect((await conn.query("select object_id('#drz_t') as t")).rows[0]!.t).not.toBeNull();
      } finally {
        other.release(conn);
      }
    } finally {
      await other.close();
    }
  });

  it("survives being chosen as a deadlock victim", async () => {
    const other = new SybasePool({ ...config, max: 1 });
    const otherSession = new SybaseSession(other);
    const table = `tempdb..drz_deadlock_${process.pid}`;
    await session.execute(
      `create table ${table} (k int primary key, v int) lock datarows\n` +
        `insert into ${table} values (1, 0)\ninsert into ${table} values (2, 0)`
    );
    try {
      let step!: () => void;
      const bothLocked = new Promise<void>(r => (step = r));
      let locked = 0;
      const lockThen = (s: SybaseSession, first: number, second: number) =>
        s.transaction(async tx => {
          await tx.execute(`update ${table} set v = 1 where k = ${first}`);
          if (++locked === 2) {
            step();
          }
          await bothLocked;
          await tx.execute(`update ${table} set v = 2 where k = ${second}`).catch(() => {});
        });
      const outcomes = await Promise.allSettled([
        lockThen(session, 1, 2),
        lockThen(otherSession, 2, 1)
      ]);
      const rejected = outcomes.filter(o => o.status === "rejected") as PromiseRejectedResult[];
      // The victim swallowed its 1205; its transaction must not report success.
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason.message).toMatch(/rolled back by the server/);
    } finally {
      await session.execute(`drop table ${table}`);
      await other.close();
    }
  });
});

/**
 * The column factories' TypeScript types are checked against the registry by
 * `introspect/__tests__/generated-schema.test-d.ts`; this checks the registry
 * against what the server actually hands back, closing the loop.
 */
describe.skipIf(!hasConfig)("decoded value types match the type registry", () => {
  /** A literal of each type, and the runtime check for its registry value kind. */
  const SAMPLE: Record<string, string> = {
    int: "1",
    bigint: "9007199254740993",
    smallint: "1",
    tinyint: "1",
    usmallint: "65535",
    uint: "4294967295",
    ubigint: "18446744073709551615",
    varchar: "'a'",
    nvarchar: "'a'",
    char: "'a'",
    nchar: "'a'",
    univarchar: "'a'",
    unichar: "'a'",
    text: "'a'",
    unitext: "0x6100",
    datetime: "'2020-01-02 03:04:05.006'",
    smalldatetime: "'2020-01-02 03:04'",
    date: "'2020-01-02'",
    time: "'03:04:05'",
    bigdatetime: "'2020-01-02 03:04:05.123456'",
    bigtime: "'03:04:05.123456'",
    numeric: "12.34",
    decimal: "12.34",
    float: "1.5",
    real: "1.5",
    money: "12.3456",
    smallmoney: "12.3456",
    bit: "1",
    binary: "0x01",
    varbinary: "0x01",
    image: "0x01"
  };

  const IS: Record<ValueKind, (v: unknown) => boolean> = {
    number: v => typeof v === "number",
    bigint: v => typeof v === "bigint",
    decimal: v => typeof v === "string",
    string: v => typeof v === "string",
    boolean: v => typeof v === "boolean",
    date: v => v instanceof Date,
    buffer: v => Buffer.isBuffer(v)
  };

  it("covers every registry type", () => {
    expect(Object.keys(SAMPLE).toSorted()).toEqual(Object.keys(SYBASE_TYPE_MAP).toSorted());
  });

  it("decodes every type as the registry says", async () => {
    const pool = new SybasePool({ ...config, max: 1 });
    const session = new SybaseSession(pool);
    const types = Object.keys(SAMPLE);
    const decl = (type: string) =>
      [
        "varchar",
        "nvarchar",
        "char",
        "nchar",
        "univarchar",
        "unichar",
        "binary",
        "varbinary"
      ].includes(type)
        ? `${type}(4)`
        : ["numeric", "decimal"].includes(type)
          ? `${type}(18,2)`
          : ({ usmallint: "unsigned smallint", uint: "unsigned int", ubigint: "unsigned bigint" }[
              type
            ] ?? type);
    try {
      await session.withConnection(async c => {
        await c.execute(
          `create table #types (${types.map(t => `c_${t} ${decl(t)} ${t === "bit" ? "not null" : "null"}`).join(", ")})`
        );
        await c.execute(
          `insert into #types (${types.map(t => `c_${t}`).join(", ")}) values (${types.map(t => SAMPLE[t]).join(", ")})`
        );
        const { rows } = await c.execute("select * from #types");
        for (const type of types) {
          const value = rows[0]![`c_${type}`];
          expect(IS[SYBASE_TYPE_MAP[type]!.value](value), `${type}: ${String(value)}`).toBe(true);
        }
        // bigint is a real BigInt, exact past 2^53; unsigned types reach their maxima exactly.
        expect(rows[0]!.c_bigint).toBe(9007199254740993n);
        expect(rows[0]!.c_usmallint).toBe(65535);
        expect(rows[0]!.c_uint).toBe(4294967295);
        expect(rows[0]!.c_ubigint).toBe(18446744073709551615n);
        // unitext round-trips as UTF-16LE bytes.
        expect((rows[0]!.c_unitext as Buffer).toString("utf16le")).toBe("a");
      });
    } finally {
      await pool.close();
    }
  });
});

/**
 * Rows streamed to a CSV file: the file must hold exactly what the column path
 * returns, in RFC 4180 form, with NULL and the empty string kept apart.
 */
describe.skipIf(!hasConfig)("rows streamed to a CSV file (live)", () => {
  /** Strict RFC 4180: rows of fields, `null` for an empty unquoted field. */
  const parseCsv = (text: string): (string | null)[][] => {
    const rows: (string | null)[][] = [];
    let row: (string | null)[] = [];
    let i = 0;
    while (i < text.length) {
      let field: string | null;
      if (text[i] === '"') {
        let value = "";
        i++;
        for (;;) {
          const close = text.indexOf('"', i);
          if (close < 0) {
            throw new Error("unterminated quoted field");
          }
          value += text.slice(i, close);
          if (text[close + 1] === '"') {
            value += '"';
            i = close + 2;
          } else {
            i = close + 1;
            break;
          }
        }
        field = value;
      } else {
        let end = i;
        while (end < text.length && text[end] !== "," && text[end] !== "\n") {
          end++;
        }
        const raw = text.slice(i, end);
        if (raw.includes('"') || raw.includes("\r")) {
          throw new Error(`unquoted field holds a quote or CR: ${JSON.stringify(raw)}`);
        }
        field = raw === "" ? null : raw;
        i = end;
      }
      row.push(field);
      if (text[i] === ",") {
        i++;
      } else if (text[i] === "\n") {
        rows.push(row);
        row = [];
        i++;
      } else if (i < text.length) {
        throw new Error(`unexpected ${JSON.stringify(text[i])} after a field`);
      }
    }
    if (row.length > 0) {
      throw new Error("last row has no line end");
    }
    return rows;
  };

  const EXPRS: [string, string][] = [
    ["s", "'plain'"],
    ["s_empty", "convert(varchar(5), '')"],
    ["s_comma", "'a,b'"],
    ["s_quote", "'say \"hi\"'"],
    ["s_lf", "'line1' + char(10) + 'line2'"],
    ["s_crlf", "'cr' + char(13) + char(10) + 'lf'"],
    ["s_lead", "' lead'"],
    ["s_trail", "'trail '"],
    ["s_tab", "char(9) + 'tab'"],
    ["s_onlyquote", "'\"'"],
    ["s_nul", "'a' + char(0) + 'b'"],
    // Bytes that are not UTF-8: the file carries the same U+FFFD a JS string gets.
    ["s_latin", "'caf' + char(233)"],
    [
      "s_bad",
      "'a' + char(226) + char(130) + 'b' + char(255) + char(240) + char(159) + char(152) + char(128) + char(237) + char(160) + char(128)"
    ],
    ["c_pad", "convert(char(6), 'ab')"],
    ["ti", "convert(tinyint, 255)"],
    ["si", "convert(smallint, -32768)"],
    ["i", "convert(int, -2147483648)"],
    ["bi", "convert(bigint, -9223372036854775808)"],
    ["ubi", "convert(unsigned bigint, 18446744073709551615)"],
    ["ui", "convert(unsigned int, 4294967295)"],
    ["f", "convert(float, 0.1) + convert(float, 0.2)"],
    ["f_small", "convert(float, 0.00001)"],
    ["r", "convert(real, 3.14)"],
    ["m", "convert(money, -922337203685477.5808)"],
    ["n", "convert(numeric(38,10), -1234567890123456789012345678.0123456789)"],
    ["dt", "convert(datetime, '2016-06-09 09:48:46.753')"],
    ["sdt", "convert(smalldatetime, '2079-06-06 23:59')"],
    ["d", "convert(date, '2016-06-09')"],
    ["t", "convert(time, '23:59:59.997')"],
    ["bdt", "convert(bigdatetime, '2016-06-09 09:48:46.123456')"],
    ["vb", "convert(varbinary(4), 0xde2cad22)"]
  ];
  // Row 1 holds every value, row 2 a NULL in every column (bit cannot be NULL).
  const EDGE_SQL = [
    `select 1 as id, ${EXPRS.map(([n, e]) => `${e} as ${n}`).join(", ")}, convert(bit, 1) as b1, convert(bit, 0) as b0`,
    `select 2, ${EXPRS.map(([, e]) => `case when 1 = 0 then ${e} end`).join(", ")}, convert(bit, 0), convert(bit, 1)`
  ].join(" union all ");

  let pool: SybasePool;
  let dir: string;

  beforeAll(() => {
    pool = new SybasePool({ ...config, max: 1 });
    dir = mkdtempSync(join(tmpdir(), "drizzle-sybase-csv-"));
  });

  afterAll(async () => {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The text the file must hold for a column-path value. */
  const asText = (value: unknown): string | null =>
    value === null ? null : Buffer.isBuffer(value) ? value.toString("hex") : String(value);

  it("holds exactly what the column path returns", async () => {
    const path = join(dir, "edge.csv");
    const file = await pool.queryToFile(`${EDGE_SQL} order by 1`, { path });
    const columnar = await pool.queryColumns(`${EDGE_SQL} order by 1`);
    const text = readFileSync(path, "utf8");
    expect(file.bytes).toBe(Buffer.byteLength(text));
    expect(file.rowCount).toBe(2);
    const [header, ...rows] = parseCsv(text);
    expect(header).toEqual(columnar.columns.map(c => c.name));
    expect(file.columnTypes).toEqual(columnar.columns.map(c => c.type));
    for (let r = 0; r < rows.length; r++) {
      columnar.columns.forEach((c, k) => {
        const expected = c.nulls?.[r] === 1 ? null : c.values[r];
        const got = rows[r]![k]!;
        if (typeof expected === "number" && c.type !== "int") {
          // Same double, not necessarily the same spelling (1e-05 vs 0.00001).
          expect(Number(got), c.name).toBe(expected);
        } else {
          expect(got, `${c.name} row ${r}`).toBe(asText(expected));
        }
      });
    }
    // NULL and the empty string stay apart.
    expect(rows[0]![header!.indexOf("s_empty")]).toBe("");
    expect(rows[1]![header!.indexOf("s_empty")]).toBeNull();
  });

  it("streams a result far larger than its write buffer", async () => {
    const path = join(dir, "big.csv");
    const sql =
      "select a.number * 2048 + b.number as id, replicate('x', b.number % 50) + ',\"' as s " +
      "from master..spt_values a, master..spt_values b " +
      "where a.type = 'P' and b.type = 'P' and a.number < 100";
    const file = await pool.queryToFile(sql, { path });
    const rows = parseCsv(readFileSync(path, "utf8")).slice(1);
    expect(rows).toHaveLength(file.rowCount);
    expect(file.bytes).toBeGreaterThan(2 * 1024 * 1024);
    const { rows: expected } = await pool.query<{ n: number; s: number }>(
      `select count(*) as n, sum(convert(numeric(20,0), x.id)) as s from (${sql}) x`
    );
    expect(file.rowCount).toBe(expected[0]!.n);
    expect(String(rows.reduce((acc, row) => acc + BigInt(row[0]!), 0n))).toBe(
      String(expected[0]!.s)
    );
    expect(rows.every(row => row[1]!.endsWith(',"'))).toBe(true);
  });

  it("caps the rows only at an explicit maxRows", async () => {
    const path = join(dir, "capped.csv");
    const file = await pool.queryToFile("select name from sysobjects", { path, maxRows: 3 });
    expect(file.rowCount).toBe(3);
    expect(parseCsv(readFileSync(path, "utf8"))).toHaveLength(4);
  });

  /** Files in the directory other than the ones named, i.e. leftover temporaries. */
  const strays = (...expected: string[]) =>
    readdirSync(dir).filter(name => !expected.includes(name) && name.includes(".csv."));

  it("leaves no file behind when the query fails", async () => {
    const path = join(dir, "failed.csv");
    await expect(
      pool.queryToFile("select convert(int, name) as v from sysobjects", { path })
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(strays()).toEqual([]);
  });

  // The file is written beside the target and renamed into place: a failed
  // attempt (a retry, say) must not destroy the result of an earlier one.
  it("keeps an existing file when a query fails, and replaces it only on success", async () => {
    const path = join(dir, "kept.csv");
    writeFileSync(path, "earlier result\n");
    await expect(pool.queryToFile("select 1/0 as v", { path })).rejects.toThrow(/Msg 3607/);
    expect(readFileSync(path, "utf8")).toBe("earlier result\n");
    await pool.queryToFile("select 7 as v", { path });
    expect(readFileSync(path, "utf8")).toBe("v\n7\n");
    expect(strays("kept.csv")).toEqual([]);
  });

  // A connection closed mid-export is how the JS layer gives up on a query;
  // the export must not appear afterwards as if it had succeeded.
  it("publishes nothing once the connection is closed mid-export", async () => {
    const path = join(dir, "abandoned.csv");
    const conn = new SybaseConnection({ ...config });
    await conn.connect();
    const pending = conn.queryToFile("waitfor delay '00:00:02'\nselect 1 as v", { path });
    await new Promise(resolve => setTimeout(resolve, 300));
    conn.close();
    await expect(pending).rejects.toThrow();
    // The native worker finishes its waitfor after the rejection; give it time.
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(existsSync(path)).toBe(false);
    expect(strays()).toEqual([]);
  }, 20_000);

  // An empty unquoted field is NULL, so empty bytes have to be quoted.
  it("keeps empty binary apart from NULL", async () => {
    const path = join(dir, "binary.csv");
    // convert(image, null) reaches db-lib as empty bytes, not NULL; a NULL
    // varbinary is a real NULL.
    const sql =
      "select convert(image, 0x01) as b, convert(varbinary(4), null) as n " +
      "union all select convert(image, null), convert(varbinary(4), null)";
    await pool.queryToFile(sql, { path });
    const columnar = await pool.queryColumns(sql);
    expect(columnar.columns[0]!.values).toEqual([Buffer.from([1]), Buffer.alloc(0)]);
    expect(readFileSync(path, "utf8")).toBe('b,n\n01,\n"",\n');
    expect(parseCsv(readFileSync(path, "utf8")).slice(1)).toEqual([
      ["01", null],
      ["", null]
    ]);
  });

  it("rejects a path it cannot write", async () => {
    await expect(
      pool.queryToFile("select 1 as v", { path: join(dir, "missing-dir", "x.csv") })
    ).rejects.toThrow(/Could not create/);
  });

  it.each([[""], ["a\0b.csv"]])("rejects the path %j before running anything", async path => {
    await expect(pool.queryToFile("select 1 as v", { path })).rejects.toThrow(TypeError);
  });
});

/**
 * Text against a server whose character set is iso_1: single-byte text is
 * Latin-1, one byte to one code point in both directions, and a character past
 * U+00FF travels only as a U& literal.
 */
describe.skipIf(!hasConfig)("text encoding on an iso_1 server (live)", () => {
  let pool: SybasePool;
  let iso1 = false;

  beforeAll(async () => {
    pool = new SybasePool({ ...config, max: 1 });
    const { rows } = await pool.query<{ cs: string }>(
      "select name as cs from master..syscharsets where id = " +
        "(select value from master..sysconfigures where config = 131)"
    );
    iso1 = rows[0]?.cs === "iso_1";
  });

  afterAll(async () => {
    await pool.close();
  });

  const LATIN1_SQL =
    "select 'caf' + char(233) as a, char(146) as b, char(255) as c, convert(char(4), char(233)) as d";

  it("reads Latin-1 bytes as their code points, on every path", async ctx => {
    if (!iso1) {
      ctx.skip();
    }
    const expected = { a: "café", b: "\u0092", c: "ÿ", d: "é" };
    expect((await pool.query(LATIN1_SQL)).rows).toEqual([expected]);
    const columnar = await pool.queryColumns(LATIN1_SQL);
    expect(Object.fromEntries(columnar.columns.map(c => [c.name, c.values[0]]))).toEqual(expected);
    const dir = mkdtempSync(join(tmpdir(), "drizzle-sybase-enc-"));
    try {
      await pool.queryToFile(LATIN1_SQL, { path: join(dir, "a.csv") });
      expect(readFileSync(join(dir, "a.csv"), "utf8")).toBe(`a,b,c,d\ncafé,\u0092,ÿ,é\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes Latin-1 as one byte per character and unichar text exactly", async ctx => {
    if (!iso1) {
      ctx.skip();
    }
    const session = new SybaseSession(pool);
    await session.withConnection(async c => {
      await c.execute("create table #enc (v varchar(20) null, u univarchar(20) null)");
      await c.execute(
        `insert into #enc values (${serializeValue("café ÿ")}, ${serializeValue("日本 😀 é")})`
      );
      const { rows } = await c.execute(
        "select v, u, convert(varbinary(20), v) as vb, convert(varbinary(40), u) as ub from #enc"
      );
      expect(rows[0]!.v).toBe("café ÿ");
      expect(rows[0]!.u).toBe("日本 😀 é");
      expect((rows[0]!.vb as Buffer).toString("hex")).toBe(
        Buffer.from("café ÿ", "latin1").toString("hex")
      );
      // univarchar is UTF-16 on the server, in its byte order.
      const ub = rows[0]!.ub as Buffer;
      expect([ub.toString("utf16le"), Buffer.from(ub).swap16().toString("utf16le")]).toContain(
        "日本 😀 é"
      );
    });
  });

  it("refuses text a char column cannot hold, server side", async ctx => {
    if (!iso1) {
      ctx.skip();
    }
    const session = new SybaseSession(pool);
    await session.withConnection(async c => {
      await c.execute("create table #enc2 (v varchar(20) null)");
      await expect(
        c.execute(`insert into #enc2 values (${serializeValue("日本")})`)
      ).rejects.toThrow(/Msg 2402/);
    });
  });

  it("refuses raw SQL text that iso_1 cannot carry, before sending it", async ctx => {
    if (!iso1) {
      ctx.skip();
    }
    await expect(pool.query("select '日' as v")).rejects.toThrow(/U\+65E5 .*U&'\\65e5'/);
  });

  it("decodes column aliases and server messages too", async ctx => {
    if (!iso1) {
      ctx.skip();
    }
    expect((await pool.query("select 1 as [café]")).rows).toEqual([{ café: 1 }]);
    await expect(pool.query("raiserror 20001 'bad café'")).rejects.toThrow(/bad café/);
  });
});

/**
 * The column-by-column path end to end: the same values as the row path, typed
 * arrays where the type allows, and text runs split back correctly.
 */
describe.skipIf(!hasConfig)("column-by-column results (live)", () => {
  // One row in three NULL in every column, so each kind carries a NULL mask.
  const MIXED = `select number as id,
    case when number % 3 = 0 then null else convert(tinyint, number % 256) end as ti,
    case when number % 3 = 0 then null else convert(int, number - 100) end as i,
    case when number % 3 = 0 then null else convert(bigint, number) * 4294967296 end as bi,
    case when number % 3 = 0 then null else convert(unsigned int, number) end as ui,
    case when number % 3 = 0 then null else convert(float, number) / 7 end as f,
    case when number % 3 = 0 then null else convert(real, number) / 7 end as r,
    case when number % 3 = 0 then null else convert(money, number) / 100 end as m,
    case when number % 3 = 0 then null else convert(char(6), convert(varchar, number)) end as c,
    case when number % 3 = 0 then null else dateadd(minute, number * 41, '2016-03-30') end as dt,
    case when number % 3 = 0 then null else convert(varbinary(4), number) end as vb,
    convert(bit, number % 2) as bt
    from master..spt_values where type = 'P' order by number`;

  let pool: SybasePool;
  let session: SybaseSession;

  beforeAll(() => {
    pool = new SybasePool({ ...config, max: 1 });
    session = new SybaseSession(pool, "Australia/Sydney");
  });

  afterAll(async () => {
    await pool.close();
  });

  it("holds exactly what the rows hold", async () => {
    const { rows } = await session.execute(MIXED);
    const columnar = await session.executeColumns(MIXED);
    expect(columnar.rowCount).toBe(rows.length);
    const rebuilt = Array.from({ length: columnar.rowCount }, (_, r) =>
      Object.fromEntries(
        columnar.columns.map(c => {
          const value = c.nulls?.[r] === 1 ? null : c.values[r];
          // datetime arrives as epoch milliseconds; rows hold the same instant as a Date.
          return [
            c.name,
            c.type === "datetime" && value !== null ? new Date(value as number) : value
          ];
        })
      )
    );
    expect(rebuilt).toEqual(rows);
    expect(Object.fromEntries(columnar.columns.map(c => [c.name, c.values.constructor]))).toEqual({
      id: Int32Array,
      ti: Int32Array,
      i: Int32Array,
      bi: BigInt64Array,
      ui: Float64Array,
      f: Float64Array,
      r: Float64Array,
      m: Array,
      c: Array,
      dt: Float64Array,
      vb: Array,
      bt: Array
    });
    expect(rows[1]!.dt).toEqual(new Date("2016-03-29T13:41:00.000Z"));
  });

  it("is reachable from the pool and the drizzle handle", async () => {
    const db = createSybaseDrizzle({ ...config, max: 1, timeZone: "Australia/Sydney" });
    try {
      const fromDb = await db.executeColumns(sql`select convert(int, ${7}) as v`);
      expect(fromDb.columns[0]!.values).toEqual(Int32Array.of(7));
      // Without a session, datetime stays canonical text, as in pool.query rows.
      const fromPool = await pool.queryColumns("select convert(datetime, '2016-06-09') as d");
      expect(fromPool.columns[0]!.values).toEqual(["2016-06-09 00:00:00.000"]);
    } finally {
      await db.close();
    }
  });

  // Empty strings and NULLs spread across the addon's 16 KB runs, with long
  // values pushing run boundaries between them.
  it("cuts empty values and NULLs across run boundaries", async () => {
    const sql =
      "select number as n, case number % 4 when 0 then '' when 1 then null " +
      "when 2 then replicate('y', 300) else 'é' + char(0) end as s " +
      "from master..spt_values where type = 'P' order by number";
    const { rows } = await pool.query<{ n: number; s: string | null }>(sql);
    expect(rows.length).toBeGreaterThan(1000);
    const expected = ["", null, "y".repeat(300), "é\u0000"];
    expect(rows.every(({ n, s }) => s === expected[n % 4])).toBe(true);
  });

  it("splits long text that spans many runs", async () => {
    // ~400 KB of text: many of the addon's 16 KB runs.
    const { rows } = await pool.query<{ n: number; s: string }>(
      "select number as n, replicate('x', 200) + convert(varchar, number) as s " +
        "from master..spt_values where type = 'P' order by number"
    );
    expect(rows.length).toBeGreaterThan(1000);
    for (const row of rows) {
      expect(row.s).toBe(`${"x".repeat(200)}${row.n}`);
    }
  });

  it("decodes values exactly", async () => {
    const { rows } = await pool.query(
      "select convert(real, 3.14) as r, convert(char(5), 'ab') as c, " +
        "convert(text, null) as t, 'a' + char(0) + 'b' as nul"
    );
    // A NUL is an ordinary character: the value is not cut short at it.
    expect(rows).toEqual([{ r: 3.1400001, c: "ab", t: "", nul: "a\u0000b" }]);
  });
});

/**
 * Every column factory through the query builders end to end: what an insert
 * accepts (the declared write type) comes back from a select as the declared
 * read type — including each type's extremes, non-ASCII text and NULL.
 */
describe.skipIf(!hasConfig)("builder round trip for every column type", () => {
  const rt = sybaseTable("#rt", {
    k: int("k").notNull(),
    i: int("i"),
    si: smallint("si"),
    ti: tinyint("ti"),
    bi: bigint("bi"),
    us: unsignedSmallint("us"),
    ui: unsignedInt("ui"),
    ub: unsignedBigint("ub"),
    f: float("f"),
    r: real("r"),
    n: numeric("n", { precision: 18, scale: 2 }),
    nw: numeric("nw", { precision: 30, scale: 0 }),
    m: money("m"),
    sm: smallmoney("sm"),
    b: bit("b").notNull().default(false),
    dt: datetime("dt"),
    sdt: smalldatetime("sdt"),
    d: date("d"),
    tm: time("tm"),
    bdt: bigdatetime("bdt"),
    bt: bigtime("bt"),
    c: char("c", { length: 4 }),
    vc: varchar("vc", { length: 20 }),
    nc: nchar("nc", { length: 4 }),
    nvc: nvarchar("nvc", { length: 20 }),
    uc: unichar("uc", { length: 4 }),
    uvc: univarchar("uvc", { length: 20 }),
    t: text("t"),
    ut: unitext("ut"),
    bin: binary("bin", { length: 4 }),
    vbin: varbinary("vbin", { length: 4 }),
    img: image("img")
  });

  const DDL = `create table #rt (
    k int not null, i int null, si smallint null, ti tinyint null, bi bigint null,
    us unsigned smallint null, ui unsigned int null, ub unsigned bigint null,
    f float null, r real null, n numeric(18,2) null, nw numeric(30,0) null,
    m money null, sm smallmoney null, b bit default 0 not null,
    dt datetime null, sdt smalldatetime null, d date null, tm time null,
    bdt bigdatetime null, bt bigtime null,
    c char(4) null, vc varchar(20) null, nc nchar(4) null, nvc nvarchar(20) null,
    uc unichar(4) null, uvc univarchar(20) null, t text null, ut unitext null,
    bin binary(4) null, vbin varbinary(4) null, img image null)`;

  it("writes every declared write type and reads back the declared read type", async () => {
    const db = createSybaseDrizzle({ ...config, max: 1 });
    try {
      await db.withConnection(async conn => {
        await conn.executeRaw(DDL);
        const written = {
          k: 1,
          i: 2147483647,
          si: -32768,
          ti: 255,
          bi: 9223372036854775807n,
          us: 65535,
          ui: 4294967295,
          ub: 18446744073709551615n,
          f: 1.5,
          r: 1.5,
          n: "12.34",
          nw: 123456789012345678901234567890n,
          m: "922337203685477.5807",
          sm: 12.5,
          b: true,
          dt: new Date("2020-01-02T03:04:05.000Z"),
          sdt: new Date("2020-01-02T03:04:00.000Z"),
          d: "2020-01-02",
          tm: "03:04:05",
          bdt: "2020-01-02 03:04:05.123456",
          bt: "03:04:05.123456",
          c: "abcd",
          vc: "héllo",
          nc: "abcd",
          nvc: "héllo",
          uc: "abcd",
          uvc: "héllo 日本",
          t: "some text",
          ut: Buffer.from("héllo 日本", "utf16le"),
          bin: Buffer.from([1, 2, 3, 4]),
          vbin: Buffer.from([5, 6]),
          img: Buffer.from([7, 8, 9])
        } satisfies typeof rt.$inferInsert;
        await conn.insert(rt).values(written);
        // Every nullable column left out, the bit filled by its database default.
        await conn.insert(rt).values({ k: 2 });

        const rows = await conn.select().from(rt).orderBy(rt.k);
        expect(rows[0]).toEqual({
          ...written,
          n: "12.34",
          nw: "123456789012345678901234567890",
          m: "922337203685477.5807",
          sm: "12.5000",
          tm: "03:04:05.000"
        } satisfies typeof rt.$inferSelect);
        expect((rows[0]!.ut as Buffer).toString("utf16le")).toBe("héllo 日本");
        expect(rows[1]).toEqual({
          ...Object.fromEntries(Object.keys(written).map(key => [key, null])),
          k: 2,
          b: false
        });

        // The same values work as comparison parameters.
        const found = await conn
          .select({ k: rt.k })
          .from(rt)
          .where(
            and(
              eq(rt.ub, 18446744073709551615n),
              eq(rt.ui, 4294967295),
              eq(rt.m, "922337203685477.5807"),
              eq(rt.d, "2020-01-02"),
              eq(rt.dt, new Date("2020-01-02T03:04:05.000Z"))
            )
          );
        expect(found).toEqual([{ k: 1 }]);
      });
    } finally {
      await db.close();
    }
  });
});

// A procedure that commits cannot be seen in the SQL text: the driver catches
// it after the call and lets nothing more run in the transaction.
describe.skipIf(!hasConfig)("procedure that ends the transaction (live)", () => {
  it("refuses every later statement and reports why", async ctx => {
    const pool = new SybasePool({ ...config, max: 1 });
    const session = new SybaseSession(pool);
    const name = `drz_ends_${process.pid}`;
    // In tempdb, never the configured (possibly real) database.
    const table = `tempdb..${name}_t`;
    try {
      await session.execute(`create table ${table} (v int)`);
      try {
        await session.execute(
          `create procedure ${name} as begin insert into ${table} values (2) commit tran end`
        );
      } catch (err) {
        // Msg 10331: the test login may not create procedures here.
        if (/Msg 10331\b/.test(String(err))) {
          ctx.skip();
        }
        throw err;
      }
      let after: unknown;
      await expect(
        session.transaction(async tx => {
          await tx.execute(`insert into ${table} values (1)`);
          await expect(tx.execute(`exec ${name}`)).rejects.toThrow(/ended by a statement/);
          after = await tx.execute(`insert into ${table} values (3)`).catch(err => err);
        })
      ).rejects.toThrow(/ended by a statement/);
      expect(String(after)).toMatch(/ended by a statement/);
      // 1 and 2 were committed by the procedure itself; 3 never ran.
      const { rows } = await session.execute<{ v: number }>(`select v from ${table} order by v`);
      expect(rows.map(r => r.v)).toEqual([1, 2]);
    } finally {
      await session.execute(`drop procedure ${name}`).catch(() => {});
      await session.execute(`drop table ${table}`).catch(() => {});
      await pool.close();
    }
  });
});

describe.skipIf(!hasConfig)("server time zone check (live)", () => {
  // Whatever zone the server keeps: a zone matching its offset must not warn,
  // one that does not must.
  it("warns when timeZone does not match the server, and not when it does", async () => {
    const probe = new SybasePool({ ...config, max: 1 });
    const { rows } = await probe.query<{ tz: number }>(
      "select datediff(second, getutcdate(), getdate()) as tz"
    );
    await probe.close();
    const serverOffset = Math.round(rows[0]!.tz / 60);
    // Zones no other test connects with: warnings are once per process per
    // server and zone, and other tests use the UTC default.
    const candidates = ["Etc/GMT", "Australia/Sydney", "Asia/Tokyo", "America/New_York"];
    const matching = candidates.find(z => !describeTimeZoneMismatch(serverOffset, z));
    const mismatched = candidates.find(z => describeTimeZoneMismatch(serverOffset, z));
    expect(matching, `no candidate zone matches offset ${serverOffset}`).toBeDefined();

    const warnings: string[] = [];
    const onWarning = (w: Error & { code?: string }) => {
      if (w.code === "DRIZZLE_SYBASE_TIMEZONE") {
        warnings.push(w.message);
      }
    };
    process.on("warning", onWarning);
    try {
      for (const timeZone of [matching!, mismatched!]) {
        const pool = new SybasePool({ ...config, max: 1, timeZone });
        await pool.query("select 1 as x");
        await pool.close();
      }
      // Warnings are emitted on the next tick.
      await new Promise(resolve => setImmediate(resolve));
      // Other tests' connections may warn about their own zones meanwhile.
      expect(warnings.filter(w => w.includes(`converted as ${matching} `))).toEqual([]);
      expect(warnings.filter(w => w.includes(`converted as ${mismatched} `))).toHaveLength(1);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

describe.skipIf(!hasConfig)("transaction after a caught statement error", () => {
  // ASE rolls the whole transaction back on a divide-by-zero. A statement run
  // afterwards would be outside the transaction (autocommit), so it must be
  // refused and the transaction must not report success.
  it("refuses statements once the server has rolled the transaction back", async () => {
    const pool = new SybasePool({ ...config, max: 1 });
    const session = new SybaseSession(pool);
    try {
      const all = (await pool.query("SELECT name FROM sysobjects WHERE type = 'S'")).rows.length;
      expect(all).toBeGreaterThan(1);

      await expect(
        session.transaction(async tx => {
          await expect(
            tx.execute("SET ROWCOUNT 1\nSELECT 1/0 AS v\nSET ROWCOUNT 0")
          ).rejects.toThrow(/Msg 3607/);
          expect(tx.aborted).toBe(true);
          await expect(tx.execute("SELECT 1 AS v")).rejects.toThrow(/rolled back by the server/);
        })
      ).rejects.toThrow(/rolled back by the server/);

      // The failed paginated batch skipped its trailing reset; the connection
      // must not carry `SET ROWCOUNT 1` back into the pool.
      const after = await pool.query("SELECT name FROM sysobjects WHERE type = 'S'");
      expect(after.rows).toHaveLength(all);
      expect((await pool.query("SELECT @@trancount AS tc")).rows[0]).toEqual({ tc: 0 });
    } finally {
      await pool.close();
    }
  });
});

describe.skipIf(!hasConfig)("connection pool", () => {
  let pool: SybasePool;

  afterAll(async () => {
    if (pool) {
      await pool.close();
    }
  });

  it("creates pool and executes queries", async () => {
    pool = new SybasePool({ ...config, max: 3 });
    const result = await pool.query("SELECT 1 AS val");
    expect(result.rows[0].val).toBe(1);
  });

  it("handles parallel queries", async () => {
    const results = await Promise.all([
      pool.query("SELECT 1 AS val"),
      pool.query("SELECT 2 AS val"),
      pool.query("SELECT 3 AS val")
    ]);
    expect(results.map(r => r.rows[0].val)).toEqual([1, 2, 3]);
  });

  it("supports transactions on single connection", async () => {
    const conn = await pool.acquire();
    await conn.query("BEGIN TRAN");
    const result = await conn.query("SELECT 42 AS tx_val");
    await conn.query("ROLLBACK TRAN");
    pool.release(conn);
    expect(result.rows[0].tx_val).toBe(42);
  });
});

describe.skipIf(!hasConfig)("drizzle API", () => {
  const db = createSybaseDrizzle(config);

  afterAll(async () => {
    await db.close();
  });

  it("executeRaw works", async () => {
    const result = await db.executeRaw(
      "SET ROWCOUNT 5\nSELECT name FROM sysobjects ORDER BY name\nSET ROWCOUNT 0"
    );
    expect(result.rows).toHaveLength(5);
  });

  it("execute with sql template works", async () => {
    const result = await db.execute(
      sql`SELECT COUNT(*) AS cnt FROM sysobjects WHERE type = ${"S"}`
    );
    expect(result.rows[0].cnt).toBeGreaterThan(0);
  });

  // The default 1,000,000-row cap can only be lifted (or lowered) per query.
  it("passes query options through execute, exec and executeRaw", async () => {
    const query = "SELECT name FROM sysobjects";
    expect((await db.executeRaw(query, { maxRows: 2 })).rows).toHaveLength(2);
    expect((await db.execute(sql.raw(query), { maxRows: 3 })).rows).toHaveLength(3);
    expect((await db.exec(sql.raw(query), { maxRows: 1 })).rows).toHaveLength(1);
    await db.transaction(async tx => {
      expect((await tx.executeRaw(query, { maxRows: 2 })).rows).toHaveLength(2);
    });
  });

  it("transaction works", async () => {
    await db.transaction(async tx => {
      const result = await tx.executeRaw("SELECT 99 AS in_tx");
      expect(result.rows[0].in_tx).toBe(99);
    });
  });

  // select() with no fields returns the table definition's property names —
  // the keys the generated schemas use — not the database column names.
  it("select() returns rows keyed by property name", async () => {
    const objects = sybaseTable("sysobjects", {
      objectName: varchar("name"),
      objectType: char("type")
    });
    const rows = await db.select().from(objects).where(eq(objects.objectType, "S")).limit(3);
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]!).toSorted()).toEqual(["objectName", "objectType"]);
    expect(rows.every(r => r.objectType === "S")).toBe(true);
  });
});
