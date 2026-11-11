/**
 * Bulk copy and per-query timeouts against a real ASE — skipped without
 * credentials. Set SYBASE_HOST, SYBASE_PORT, SYBASE_DATABASE, SYBASE_USERNAME and
 * SYBASE_PASSWORD. Works in tempdb only, on scratch tables named dsb_bcp_*,
 * dropped afterwards.
 */
import { createServer, connect as connectTcp } from "node:net";
import type { Server, Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSybaseDrizzle } from "../db.js";
import type { SybaseDrizzle } from "../db.js";
import { SybaseBulkCopyError, SybaseQueryError, SybaseTimeoutError } from "../errors.js";
import { getNative, native } from "../native/index.js";

const config = {
  host: process.env.SYBASE_HOST ?? "",
  port: Number(process.env.SYBASE_PORT ?? "5000"),
  database: process.env.SYBASE_DATABASE ?? "",
  username: process.env.SYBASE_USERNAME ?? "",
  password: process.env.SYBASE_PASSWORD ?? ""
};
const hasConfig = Boolean(config.host && config.database && config.username);

const PROBE = "tempdb..dsb_bcp_probe";
const TWIN = "tempdb..dsb_bcp_twin";
const KEYS = "tempdb..dsb_bcp_keys";
const DFLT = "tempdb..dsb_bcp_dflt";
const IDENT = "tempdb..dsb_bcp_ident";
const scratch = [PROBE, TWIN, KEYS, DFLT, IDENT];

const PROBE_COLUMNS = `(
  k int not null,
  ti tinyint null,
  si smallint null,
  i int null,
  bi bigint null,
  m money not null,
  sm smallmoney null,
  n numeric(19,4) null,
  c char(8) not null,
  cn char(8) null,
  v varchar(20) null,
  d datetime null,
  sd smalldatetime null,
  b bit not null,
  f float null,
  vb varbinary(8) null
)`;

describe.skipIf(!hasConfig)("bulk copy (real ASE)", () => {
  let db: SybaseDrizzle;
  let charset = "";

  const count = async (table: string) =>
    Number((await db.executeRaw<{ n: number }>(`select count(*) as n from ${table}`)).rows[0]!.n);

  const recreate = async (table: string, columns: string, index?: string) => {
    await db.executeRaw(`if object_id('${table}') is not null drop table ${table}`);
    await db.executeRaw(`create table ${table} ${columns}`);
    if (index) {
      await db.executeRaw(index);
    }
  };

  beforeAll(async () => {
    db = createSybaseDrizzle({
      ...config,
      max: 4,
      timeout: 60,
      packetSize: 4096,
      warnOnTimeZoneMismatch: false
    } as Parameters<typeof createSybaseDrizzle>[0]);
    const { rows } = await db.executeRaw<{ cs: string }>(
      "select name as cs from master..syscharsets where id = " +
        "(select value from master..sysconfigures where config = 131)"
    );
    charset = rows[0]!.cs;
  }, 60_000);

  afterAll(async () => {
    for (const table of scratch) {
      await db
        .executeRaw(`if object_id('${table}') is not null drop table ${table}`)
        .catch(() => {});
    }
    await db.close();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  it("stores every type exactly as the same values inserted with SQL", async () => {
    await recreate(PROBE, PROBE_COLUMNS, `create unique index ux on ${PROBE} (k)`);
    await recreate(TWIN, PROBE_COLUMNS);
    const rows = [
      [
        1,
        0,
        -32768,
        -2147483648,
        -9223372036854775808n,
        "922337203685477.5807",
        "214748.3647",
        "999999999999999.9999",
        "abc",
        "x",
        "text",
        "1753-01-01 00:00:00.000",
        "1900-01-01 00:00",
        true,
        0.1,
        Buffer.from([1, 2, 0])
      ],
      [
        2,
        255,
        32767,
        2147483647,
        9223372036854775807n,
        "-922337203685477.5808",
        "-214748.3648",
        "-0.0001",
        "",
        "",
        "",
        "9999-12-31 23:59:59.998",
        "2079-06-06 23:58:59",
        false,
        -1e300,
        Buffer.from([255])
      ],
      [3, null, null, null, null, "0", null, null, "  pad", null, null, null, null, 1, null, null],
      [
        4,
        7,
        7,
        7,
        7n,
        "12.3456",
        "1.5",
        "12.3456",
        "eight ch",
        "é",
        "trailing   ",
        "2024-02-29 10:00:00.999",
        "2024-02-29 10:00:29.999",
        0,
        3.25,
        Buffer.from([0])
      ]
    ];
    const result = await db.bulkInsert({ table: PROBE, rows, expectedRows: 4 });
    expect(result.rowsCopied).toBe(4);
    expect(result.batches).toEqual([{ rows: 4 }]);

    const literal = (v: unknown): string =>
      v === null
        ? "null"
        : Buffer.isBuffer(v)
          ? `0x${v.toString("hex")}`
          : typeof v === "boolean"
            ? v
              ? "1"
              : "0"
            : typeof v === "string"
              ? `'${v}'`
              : String(v);
    const moneyCols = new Set([5, 6]);
    await db.executeRaw(
      rows
        .map(
          row =>
            `insert ${TWIN} values (${row
              .map((v, i) =>
                (moneyCols.has(i) || i === 7) && v !== null
                  ? `convert(${i === 7 ? "numeric(19,4)" : i === 5 ? "money" : "smallmoney"}, ${literal(v)})`
                  : literal(v)
              )
              .join(", ")})`
        )
        .join("\n")
    );
    const read = async (table: string) =>
      (
        await db.executeRaw(
          `select k, ti, si, i, bi, m, sm, n, c, cn, v, d, sd, b, f, vb, ` +
            `convert(varbinary(20), c) as c_raw, convert(varbinary(20), v) as v_raw, ` +
            `convert(varbinary(20), cn) as cn_raw from ${table} order by k`
        )
      ).rows;
    const bulk = await read(PROBE);
    expect(bulk).toEqual(await read(TWIN));
    // Spot checks of what "the same as SQL" means here.
    expect(bulk[0]).toMatchObject({
      m: "922337203685477.5807",
      sm: "214748.3647",
      n: "999999999999999.9999"
    });
    expect(bulk[1]).toMatchObject({ bi: 9223372036854775807n, n: "-0.0001" });
    // An empty string is one blank in ASE (padded in char); NULL stays NULL.
    expect(bulk[1]!.v_raw).toEqual(Buffer.from(" "));
    expect(bulk[2]).toMatchObject({ cn: null, v: null, ti: null });
    // .999 is stored as .996/.997 (1/300 s), never the next second.
    expect((bulk[3]!.d as Date).toISOString()).toBe("2024-02-29T10:00:00.997Z");
    expect((bulk[3]!.sd as Date).toISOString()).toBe("2024-02-29T10:00:00.000Z");
    if (charset === "iso_1") {
      // One Latin-1 byte (a nullable char is stored unpadded, like varchar).
      expect(bulk[3]!.cn_raw).toEqual(Buffer.from([0xe9]));
    }
  }, 120_000);

  it("writes Dates as their wall clock in the configured zone", async () => {
    await recreate(PROBE, PROBE_COLUMNS);
    const zoned = createSybaseDrizzle({
      ...config,
      max: 1,
      timeZone: "Australia/Sydney",
      warnOnTimeZoneMismatch: false
    } as Parameters<typeof createSybaseDrizzle>[0]);
    try {
      const at = new Date("2024-06-30T14:00:00.000Z");
      await zoned.bulkInsert({
        table: PROBE,
        columns: ["k", "m", "c", "b", "d"],
        rows: [[1, "0", "x", 0, at]]
      });
      const { rows } = await db.executeRaw(`select convert(varchar(30), d, 23) as d from ${PROBE}`);
      expect(rows[0]!.d).toBe("2024-07-01T00:00:00");
      expect((await zoned.executeRaw(`select d from ${PROBE}`)).rows[0]!.d).toEqual(at);
    } finally {
      await zoned.close();
    }
  }, 60_000);

  it("loads TSV, including from a stream, with empty fields as NULL", async () => {
    await recreate(PROBE, PROBE_COLUMNS);
    const tsv =
      "1\t\t\t\t\t12.5\t\t\tc1\t\tv1\t2024-01-01 10:00:00\t\t1\t\t0aff\r\n2\t\t\t\t\t0\t\t\tc2\t\t\t\t\t0\t\t\n";
    await db.bulkInsert({
      table: PROBE,
      columns: [
        "k",
        "ti",
        "si",
        "i",
        "bi",
        "m",
        "sm",
        "n",
        "c",
        "cn",
        "v",
        "d",
        "sd",
        "b",
        "f",
        "vb"
      ],
      rows: [Buffer.from(tsv.slice(0, 9)), Buffer.from(tsv.slice(9))],
      expectedRows: 2
    });
    const { rows } = await db.executeRaw(`select k, m, c, v, d, vb, ti from ${PROBE} order by k`);
    expect(rows).toEqual([
      {
        k: 1,
        m: "12.5000",
        c: "c1",
        v: "v1",
        d: new Date("2024-01-01T10:00:00Z"),
        vb: Buffer.from([10, 255]),
        ti: null
      },
      { k: 2, m: "0.0000", c: "c2", v: null, d: null, vb: null, ti: null }
    ]);
  }, 60_000);

  // CR ends a row only with the LF after it: a last row without one keeps it.
  it("keeps a CR ending the last TSV row, which has no LF", async () => {
    await recreate(PROBE, PROBE_COLUMNS);
    const columns = ["k", "m", "c", "b", "v"];
    await db.bulkInsert({ table: PROBE, columns, rows: "1\t1\tx\t0\tab\r\n2\t1\tx\t0\tcd\r" });
    await db.bulkInsert({ table: PROBE, columns, rows: ["3\t1\tx\t0\t", "\r"] });
    const { rows } = await db.executeRaw(`select k, v from ${PROBE} order by k`);
    expect(rows).toEqual([
      { k: 1, v: "ab" },
      { k: 2, v: "cd\r" },
      { k: 3, v: "\r" }
    ]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Refused values: nothing committed, row and column named
  // -------------------------------------------------------------------------

  // A column's name is reported whole for a refused row, as for the failure:
  // ASE takes names of up to 255 bytes.
  it("names a long column in full for a refused row", async () => {
    const long = `c${"x".repeat(139)}`;
    await recreate(PROBE, `(k int not null, ${long} int null)`);
    const result = await db.bulkInsert({
      table: PROBE,
      rows: [
        [1, "bad"],
        [2, 2]
      ],
      maxErrors: 1
    });
    expect(result.rejected).toEqual([{ row: 1, column: long, message: expect.any(String) }]);
    const err = (await db
      .bulkInsert({ table: PROBE, rows: [[3, "bad"]] })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.column).toBe(long);
  }, 60_000);

  it.each([
    ["an unconvertible value", "m", "12.34567", /value has more than 4 decimal places/],
    [
      "an over-long string",
      "v",
      "x".repeat(21),
      /value is (at least )?21 bytes .* the column holds 20/
    ],
    ["a value out of range", "ti", 256, /not an integer in the column's range/],
    ["a NUL character", "v", "\u0000", /has a NUL character at character 1/],
    ["a NUL character inside text", "v", "a\u0000b", /has a NUL character at character 2/],
    ["a NULL for a NOT NULL column", "c", null, /allows none and has no default/]
  ])(
    "refuses %s, committing nothing",
    async (_name, columnName, value, message) => {
      await recreate(PROBE, PROBE_COLUMNS);
      const columns = ["k", "m", "c", "b", columnName].filter((c, i, all) => all.indexOf(c) === i);
      const good = (k: number) =>
        columns.map(c =>
          c === "k" ? k : c === "m" ? "1" : c === "c" ? "x" : c === "b" ? 0 : null
        );
      const bad = good(3);
      bad[columns.indexOf(columnName)] = value as never;
      const err = (await db
        .bulkInsert({ table: PROBE, columns, rows: [good(1), good(2), bad, good(4)] })
        .catch((e: unknown) => e)) as SybaseBulkCopyError;
      expect(err).toBeInstanceOf(SybaseBulkCopyError);
      expect(err.message).toMatch(message);
      expect(err.row).toBe(3);
      if (value !== null) {
        expect(err.column).toBe(columnName);
      }
      expect(err.rowsCommitted).toBe(0);
      expect(await count(PROBE)).toBe(0);
    },
    60_000
  );

  it("refuses a character the server's iso_1 cannot hold, never storing '?'", async ctx => {
    if (charset !== "iso_1") {
      // Not run, rather than counted as passed: there is nothing to check.
      ctx.skip();
      return;
    }
    await recreate(PROBE, PROBE_COLUMNS);
    const err = (await db
      .bulkInsert({
        table: PROBE,
        columns: ["k", "m", "c", "b", "v"],
        rows: [
          [1, "1", "x", 0, "café"],
          [2, "1", "x", 0, "中文"]
        ]
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/Row 2, column 'v': value has U\+4E2D at character 1/);
    expect(await count(PROBE)).toBe(0);
    // The same row under maxErrors is left out; the representable one lands as Latin-1.
    const result = await db.bulkInsert({
      table: PROBE,
      columns: ["k", "m", "c", "b", "v"],
      rows: [
        [1, "1", "x", 0, "café"],
        [2, "1", "x", 0, "中文"]
      ],
      maxErrors: 1
    });
    expect(result).toMatchObject({ rowsCopied: 1, rejectedCount: 1 });
    expect(result.rejected[0]).toMatchObject({ row: 2, column: "v" });
    const { rows } = await db.executeRaw(
      `select v, convert(varbinary(10), v) as raw from ${PROBE}`
    );
    expect(rows).toEqual([{ v: "café", raw: Buffer.from([0x63, 0x61, 0x66, 0xe9]) }]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Atomicity and truthful counts
  // -------------------------------------------------------------------------

  it("commits nothing when a one-batch load hits a duplicate key in the middle", async () => {
    await recreate(
      KEYS,
      "(k int not null, v varchar(10) null) lock datarows",
      `create unique index ux on ${KEYS} (k)`
    );
    const rows = Array.from({ length: 1000 }, (_, i) => [i === 500 ? 7 : i, "x"]);
    const err = (await db
      .bulkInsert({ table: KEYS, rows })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.msgNo).toBe(2601);
    expect(err.cause).toBeInstanceOf(SybaseQueryError);
    expect(err.rowsCommitted).toBe(0);
    expect(err.rowsInDoubt).toBe(0);
    expect(await count(KEYS)).toBe(0);
  }, 60_000);

  it("commits exactly the earlier batches when a later batch hits a duplicate key", async () => {
    await recreate(
      KEYS,
      "(k int not null, v varchar(10) null) lock datarows",
      `create unique index ux on ${KEYS} (k)`
    );
    const rows = Array.from({ length: 1000 }, (_, i) => [i === 750 ? 3 : i, "x"]);
    const err = (await db
      .bulkInsert({ table: KEYS, rows, batchSize: 300 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.rowsCommitted).toBe(600);
    expect(err.batches).toEqual([{ rows: 300 }, { rows: 300 }]);
    expect(err.message).toMatch(/600 rows were committed by 2 earlier batches; nothing else was/);
    expect(await count(KEYS)).toBe(600);
    expect(await count(`${KEYS} where k >= 600`)).toBe(0);
  }, 60_000);

  it("lets exactly one of two concurrent overlapping loads into a unique index commit", async () => {
    await recreate(
      KEYS,
      "(k int not null, v varchar(10) null) lock datarows",
      `create unique index ux on ${KEYS} (k)`
    );
    const load = (from: number, tag: string) =>
      db.bulkInsert({
        table: KEYS,
        rows: Array.from({ length: 5000 }, (_, i) => [from + i, tag]),
        timeoutSeconds: 60
      });
    const outcomes = await Promise.allSettled([load(0, "a"), load(2500, "b")]);
    const won = outcomes.filter(o => o.status === "fulfilled");
    const lost = outcomes.filter(o => o.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const err = lost[0]!.reason as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.rowsCommitted).toBe(0);
    const winner = outcomes[0]!.status === "fulfilled" ? "a" : "b";
    // All of the winner's rows, none of the loser's.
    expect(await count(KEYS)).toBe(5000);
    expect(await count(`${KEYS} where v = '${winner}'`)).toBe(5000);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Options
  // -------------------------------------------------------------------------

  it("uses the column DEFAULT for NULL, and keeps NULL with ignoreDefaults", async () => {
    await recreate(
      DFLT,
      "(k int not null, d char(1) default 'D' null, n int default 9 null, v varchar(5) null) lock datarows"
    );
    await db.bulkInsert({
      table: DFLT,
      columns: ["k", "d", "v"],
      rows: [
        [1, null, "a"],
        [2, "x", null]
      ]
    });
    await db.bulkInsert({
      table: DFLT,
      columns: ["k", "d", "v"],
      rows: [[3, null, "b"]],
      ignoreDefaults: true
    });
    await db.bulkInsert({ table: DFLT, rows: "4\t\t\t\n", ignoreDefaults: true });
    expect((await db.executeRaw(`select * from ${DFLT} order by k`)).rows).toEqual([
      { k: 1, d: "D", n: 9, v: "a" },
      { k: 2, d: "x", n: 9, v: null },
      { k: 3, d: null, n: null, v: "b" },
      { k: 4, d: null, n: null, v: null }
    ]);
  }, 60_000);

  // A default the copy fills in is the server's, as for an insert from SQL —
  // byte for byte, a character past ASCII included.
  it("fills in a non-ASCII DEFAULT exactly as an insert from SQL does", async () => {
    await recreate(
      DFLT,
      "(k int not null, d varchar(10) default 'éñx' null, c char(3) default 'ñ' null)"
    );
    await db.bulkInsert({ table: DFLT, columns: ["k"], rows: [[1]] });
    await db.bulkInsert({ table: DFLT, rows: [[2, null, null]] });
    await db.executeRaw(`insert ${DFLT} (k) values (3)`);
    const { rows } = await db.executeRaw(
      `select k, d, c, datalength(d) as dl, ascii(d) as a from ${DFLT} order by k`
    );
    const bySql = { ...rows[2], k: undefined };
    expect(rows.map(r => ({ ...r, k: undefined }))).toEqual([bySql, bySql, bySql]);
    expect(bySql).toMatchObject({ d: "éñx", c: "ñ" });
  }, 60_000);

  it("copies identity values with keepIdentity, and lets the server assign them otherwise", async () => {
    await recreate(IDENT, "(id numeric(10,0) identity, k int not null)");
    await db.withConnection(async conn => {
      const kept = await conn.bulkInsert({
        table: IDENT,
        rows: [
          [100, 1],
          [200, 2]
        ],
        keepIdentity: true
      });
      expect(kept.rowsCopied).toBe(2);
      // identity_insert is off again on this connection: a plain insert gets the next value.
      await conn.executeRaw(`insert ${IDENT} (k) values (3)`);
      await conn.bulkInsert({ table: IDENT, rows: [[4]] });
      const err = await conn
        .bulkInsert({ table: IDENT, columns: ["id", "k"], rows: [[5, 5]] })
        .catch((e: unknown) => e);
      expect(String(err)).toMatch(/identity column/);
    });
    const { rows } = await db.executeRaw(`select id, k from ${IDENT} order by k`);
    expect(rows).toEqual([
      { id: "100", k: 1 },
      { id: "200", k: 2 },
      { id: "201", k: 3 },
      { id: "202", k: 4 }
    ]);
  }, 60_000);

  it.each(["datarows", "datapages", "allpages"])(
    "loads a %s-locked table",
    async lock => {
      await recreate(KEYS, `(k int not null, v varchar(10) null, d datetime null) lock ${lock}`);
      const result = await db.bulkInsert({
        table: KEYS,
        rows: [
          [1, "a", null],
          [2, null, "2024-01-01"]
        ]
      });
      expect(result.rowsCopied).toBe(2);
      expect(await count(KEYS)).toBe(2);
    },
    60_000
  );

  it("loads #temp tables, whichever temporary database the session has", async () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 6; attempt++) {
      await db.withConnection(async conn => {
        const { rows } = await conn.executeRaw<{ t: string }>("select db_name(@@tempdbid) as t");
        seen.add(rows[0]!.t);
        await conn.executeRaw(
          "create table #stage (k int not null, v varchar(10) null) lock datarows"
        );
        const result = await conn.bulkInsert({
          table: "#stage",
          rows: [
            [1, "a"],
            [2, null]
          ]
        });
        expect(result.rowsCopied).toBe(2);
        expect((await conn.executeRaw("select count(*) as n from #stage")).rows[0]!.n).toBe(2);
      });
    }
    expect(seen.size).toBeGreaterThan(0);
  }, 120_000);

  it("refuses to run inside a transaction opened with raw SQL", async () => {
    await recreate(KEYS, "(k int not null, v varchar(10) null)");
    await db.withConnection(async conn => {
      await conn.executeRaw("begin tran");
      const err = await conn.bulkInsert({ table: KEYS, rows: [[1, "a"]] }).catch((e: unknown) => e);
      expect(String(err)).toMatch(/cannot run inside a transaction/);
      await conn.executeRaw("rollback tran");
    });
  }, 60_000);

  // ASE's bulk copy checks types, NOT NULL and unique indexes, but not CHECK
  // constraints or foreign keys (nor does it fire triggers) — the bcp utility
  // behaves the same. So such a table is refused unless the caller allows it;
  // and what allowing it means is pinned here, so the documentation stays true.
  it("refuses a table with CHECK or foreign key constraints, which bulk copy does not apply", async () => {
    const parent = "tempdb..dsb_bcp_parent";
    const child = "tempdb..dsb_bcp_child";
    await db.executeRaw(`if object_id('${child}') is not null drop table ${child}`);
    await recreate(parent, "(id int not null primary key)");
    await db.executeRaw(`insert ${parent} values (1)`);
    await db.executeRaw(
      `create table ${child} (k int not null, pid int null references ${parent}(id), ` +
        "amt int null check (amt >= 0))"
    );
    try {
      // An insert is refused...
      await expect(db.executeRaw(`insert ${child} values (1, 1, -5)`)).rejects.toThrow(
        /constraint/i
      );
      const rows = [
        [1, 1, -5],
        [2, 99, 1]
      ];
      // A bulk copy is refused before it starts...
      await expect(db.bulkInsert({ table: child, rows })).rejects.toThrow(
        /has CHECK or foreign key constraints, which a bulk copy does not apply.*allowConstraintBypass/
      );
      expect(await count(child)).toBe(0);
      // ...and when allowed, stores the rows an insert refuses.
      const result = await db.bulkInsert({ table: child, rows, allowConstraintBypass: true });
      expect(result.rowsCopied).toBe(2);
      expect((await db.executeRaw(`select k, pid, amt from ${child} order by k`)).rows).toEqual([
        { k: 1, pid: 1, amt: -5 },
        { k: 2, pid: 99, amt: 1 }
      ]);
    } finally {
      await db.executeRaw(`if object_id('${child}') is not null drop table ${child}`);
      await db.executeRaw(`if object_id('${parent}') is not null drop table ${parent}`);
    }
  }, 60_000);

  it("refuses a table with an insert trigger, which bulk copy does not fire", async () => {
    // A trigger is created in the current database only: work in tempdb.
    const temp = createSybaseDrizzle({
      ...config,
      database: "tempdb",
      max: 1,
      warnOnTimeZoneMismatch: false
    } as Parameters<typeof createSybaseDrizzle>[0]);
    const table = "dsb_bcp_trg";
    const log = "dsb_bcp_trg_log";
    const drop = async () => {
      await temp.executeRaw(`if object_id('${table}') is not null drop table ${table}`);
      await temp.executeRaw(`if object_id('${log}') is not null drop table ${log}`);
    };
    try {
      await drop();
      await temp.executeRaw(`create table ${log} (n int not null)`);
      await temp.executeRaw(`create table ${table} (k int not null)`);
      await temp.executeRaw(
        `create trigger dsb_bcp_trg_ins on ${table} for insert as insert ${log} select k from inserted`
      );
      // An insert fires it...
      await temp.executeRaw(`insert ${table} values (1)`);
      // ...a bulk copy is refused, and when allowed, does not fire it.
      await expect(temp.bulkInsert({ table, rows: [[2]] })).rejects.toThrow(
        /has an insert trigger/
      );
      await temp.bulkInsert({ table, rows: [[2], [3]], allowConstraintBypass: true });
      expect((await temp.executeRaw(`select count(*) as n from ${table}`)).rows).toEqual([
        { n: 3 }
      ]);
      expect((await temp.executeRaw(`select n from ${log}`)).rows).toEqual([{ n: 1 }]);
    } finally {
      await drop();
      await temp.close();
    }
  }, 60_000);

  // In chained mode every select opens a transaction, so no batch the copy
  // commits would be committed for good. Refused without a select of its own:
  // the session is left as it was — no transaction opened by the check.
  it("refuses to run in chained transaction mode, saying so", async () => {
    await db.withConnection(async conn => {
      await conn.executeRaw("create table #ch (k int not null)");
      await conn.executeRaw("set chained on");
      await expect(conn.bulkInsert({ table: "#ch", rows: [[1]] })).rejects.toThrow(
        /cannot run in chained transaction mode/
      );
      // An IF opens no transaction; `set chained off` fails inside one.
      expect((await conn.executeRaw("if @@trancount > 0 select 1 as still_open")).rows).toEqual([]);
      await conn.executeRaw("set chained off");
      expect((await conn.executeRaw("select count(*) as n from #ch")).rows).toEqual([{ n: 0 }]);
    });
  }, 60_000);

  // A #temp table lives in the session's own temporary database, which is not
  // always tempdb: its constraints are read from there.
  it("finds the constraints of a #temp table in the session's temporary database", async () => {
    await db.withConnection(async conn => {
      await conn.executeRaw("create table #checked (k int not null check (k > 0))");
      await conn.executeRaw("create table #plain (k int not null)");
      await expect(conn.bulkInsert({ table: "#checked", rows: [[1]] })).rejects.toThrow(
        /#checked has a rule or CHECK constraint on a column|#checked has CHECK/
      );
      // Refused before it started: the connection is still usable.
      expect((await conn.bulkInsert({ table: "#plain", rows: [[1]] })).rowsCopied).toBe(1);
      await conn.executeRaw("drop table #checked drop table #plain");
    });
  }, 60_000);

  // A copy refused while checking its columns has turned nothing on, so must
  // turn nothing off: identity_insert here is the caller's own.
  it("leaves the caller's identity_insert alone when it refuses the columns", async () => {
    await db.withConnection(async conn => {
      await conn.executeRaw("create table #idt (id numeric(10,0) identity, ts timestamp, v int)");
      await conn.executeRaw("set identity_insert #idt on");
      await expect(
        conn.bulkInsert({
          table: "#idt",
          columns: ["id", "ts", "v"],
          keepIdentity: true,
          rows: [[1, null, 1]]
        })
      ).rejects.toThrow(/cannot be bulk copied/);
      // Still on: an explicit identity value is accepted.
      await conn.executeRaw("insert #idt (id, v) values (5, 1)");
      expect((await conn.executeRaw("select id from #idt")).rows).toEqual([{ id: "5" }]);
      await conn.executeRaw("set identity_insert #idt off drop table #idt");
    });
  }, 60_000);

  // Rows that keep arriving never reach db-lib's interrupt check (it runs in
  // waits): a close must end the read itself, not leave it to the deadline.
  it("stops reading rows soon after the connection is closed", async () => {
    const handle = await native.connect({ ...config, timeout: 30 });
    const started = Date.now();
    const pending = native.query(
      handle,
      "select a.number as x from master..spt_values a, master..spt_values b, master..spt_values c",
      { maxRows: 1, hardTimeoutMs: 120_000 }
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    native.close(handle);
    await expect(pending).rejects.toMatchObject({ connectionDead: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  // db-lib takes the SQL as a C string: what follows a NUL would not run.
  it("refuses SQL holding a NUL character", async () => {
    await expect(db.executeRaw("select 1 as a\u0000select 2 as b")).rejects.toThrow(
      /contains a NUL character/
    );
  }, 60_000);

  // The binding is public: what it is given is checked, never truncated,
  // wrapped or ignored, and a getter that throws stops the call with its error.
  describe("native argument checks", () => {
    let handle: unknown;
    beforeAll(async () => {
      handle = await native.connect({ ...config, timeout: 30 });
    }, 60_000);
    afterAll(() => native.close(handle));

    it("propagates a throwing getter among bulkBegin's column names", () => {
      const columns = ["k"];
      Object.defineProperty(columns, 0, {
        get() {
          throw new Error("getter failed");
        }
      });
      expect(() =>
        getNative().bulkBegin(handle, { table: "tempdb..t", columns, hardTimeoutMs: 1000 })
      ).toThrow("getter failed");
    });

    it.each([
      [{ maxRows: 2 ** 32 + 1 }],
      [{ maxRows: 1.5 }],
      [{ hardTimeoutMs: 2 ** 31 }],
      [{ hardTimeoutMs: 0 }],
      [{ timeoutSeconds: Number.NaN }]
    ])("refuses query option %j instead of truncating it", options => {
      expect(() => getNative().query(handle, "select 1", options)).toThrow(RangeError);
    });

    it("refuses a non-boolean allResultSets", () => {
      expect(() =>
        getNative().query(handle, "select 1", { allResultSets: "yes" } as never)
      ).toThrow(TypeError);
    });

    it.each([
      [{ rows: 1.5, tsv: "1\n", hardTimeoutMs: 1000 }],
      [{ rows: 1, maxRejects: -1, tsv: "1\n", hardTimeoutMs: 1000 }],
      [{ rows: 1, commit: 3, tsv: "1\n", hardTimeoutMs: 1000 }],
      [{ rows: 1, tsv: "1\n" }]
    ])("refuses bulkSend header %j", chunk => {
      expect(() => getNative().bulkSend(handle, chunk as never)).toThrow(RangeError);
    });
  });

  // A TSV chunk holds exactly the rows it says, checked before any is sent:
  // more would be left out without a word, fewer read past the data.
  it.each([
    ["more rows than said", "1\ta\n2\tb\n", 1],
    ["fewer rows than said", "1\ta\n", 2]
  ])(
    "refuses a TSV chunk with %s",
    async (_name, tsv, rows) => {
      await recreate(KEYS, "(k int not null, v varchar(10) null)");
      const handle = await native.connect({ ...config, timeout: 30 });
      try {
        await getNative().bulkBegin(handle, { table: KEYS, hardTimeoutMs: 30_000 });
        await expect(
          getNative().bulkSend(handle, {
            rows,
            firstRow: 1,
            maxRejects: 0,
            commit: 2,
            tsv,
            hardTimeoutMs: 30_000
          })
        ).rejects.toThrow(/malformed bulk rows/);
      } finally {
        native.close(handle);
      }
      expect(await count(KEYS)).toBe(0);
    },
    60_000
  );

  it("reports a query on a closed native handle as a dead connection", async () => {
    const handle = await native.connect({ ...config, timeout: 30 });
    native.close(handle);
    await expect(native.query(handle, "select 1")).rejects.toMatchObject({ connectionDead: true });
  }, 60_000);

  // A datarows row carries a 2-byte offset per variable column, which the row
  // buffer once had no room for: 100 full varbinary(8) columns wrote 93 bytes
  // past it. Every value must come back as sent.
  // An allpages row's adjustment table counts the whole row, fixed columns
  // included: the buffer once had room for one counted from the variable data
  // alone, and this row (1500 bytes of data) wrote 3 bytes past it.
  it("copies a full row with a wide fixed part into an allpages table intact", async () => {
    const table = "tempdb..dsb_bcp_aplwide";
    const fixed = Array.from({ length: 6 }, (_, i) => `f${i} binary(248) not null`).join(", ");
    await recreate(table, `(${fixed}, v varbinary(8) not null) lock allpages`);
    try {
      const row = [
        ...Array.from({ length: 6 }, (_, i) => new Uint8Array(248).fill(i + 1)),
        new Uint8Array(8).fill(0xab)
      ];
      expect((await db.bulkInsert({ table, rows: [row, row] })).rowsCopied).toBe(2);
      const back = (await db.executeRaw(`select * from ${table}`)).rows;
      expect(back).toHaveLength(2);
      for (const r of back) {
        for (let i = 0; i < 6; i++) {
          expect(Buffer.from(r[`f${i}`] as Uint8Array)).toEqual(Buffer.alloc(248, i + 1));
        }
        expect(Buffer.from(r.v as Uint8Array)).toEqual(Buffer.alloc(8, 0xab));
      }
    } finally {
      await db.executeRaw(`drop table ${table}`);
    }
  }, 60_000);

  it("copies a full row of a wide datarows table intact", async () => {
    const table = "tempdb..dsb_bcp_dol";
    const cols = Array.from({ length: 100 }, (_, i) => `b${i} varbinary(8) null`).join(", ");
    await recreate(table, `(k int not null, ${cols}) lock datarows`);
    try {
      const rows = Array.from({ length: 50 }, (_, r) => [
        r,
        ...Array.from({ length: 100 }, (_, i) => new Uint8Array(8).fill(((r + i) % 255) + 1))
      ]);
      expect((await db.bulkInsert({ table, rows })).rowsCopied).toBe(50);
      const back = (await db.executeRaw(`select * from ${table} order by k`)).rows;
      expect(back).toHaveLength(50);
      for (const [r, row] of back.entries()) {
        for (let i = 0; i < 100; i++) {
          expect(Buffer.from(row[`b${i}`] as Uint8Array)).toEqual(
            Buffer.alloc(8, ((r + i) % 255) + 1)
          );
        }
      }
    } finally {
      await db.executeRaw(`drop table ${table}`);
    }
  }, 120_000);

  // Their offsets are counted in one byte: refused before anything is sent.
  it("refuses a table with more than 255 variable-length columns", async () => {
    const table = "tempdb..dsb_bcp_wide";
    const cols = Array.from({ length: 256 }, (_, i) => `v${i} varbinary(1) null`).join(", ");
    await recreate(table, `(${cols}) lock datarows`);
    try {
      await expect(
        db.bulkInsert({ table, rows: [Array.from({ length: 256 }, () => new Uint8Array([1]))] })
      ).rejects.toThrow(
        /has 256 variable-length or nullable columns; a bulk copy supports at most 255/
      );
    } finally {
      await db.executeRaw(`drop table ${table}`);
    }
  }, 60_000);

  // sysconstraints lists computed columns too; they are not CHECK constraints.
  it("does not take a computed column for a constraint", async () => {
    const table = "tempdb..dsb_bcp_comp";
    await recreate(table, "(a int not null, c as a + 1)");
    try {
      const result = await db.bulkInsert({ table, columns: ["a"], rows: [[1], [2]] });
      expect(result.rowsCopied).toBe(2);
      expect((await db.executeRaw(`select a, c from ${table} order by a`)).rows).toEqual([
        { a: 1, c: 2 },
        { a: 2, c: 3 }
      ]);
    } finally {
      await db.executeRaw(`drop table ${table}`);
    }
  }, 60_000);

  it("refuses keepIdentity without the identity column among the columns", async () => {
    const table = "tempdb..dsb_bcp_kid";
    await recreate(table, "(id numeric(10,0) identity, v int null)");
    try {
      await expect(
        db.bulkInsert({ table, columns: ["v"], keepIdentity: true, rows: [[1]] })
      ).rejects.toThrow(/keepIdentity copies the identity column's values, but 'id' is not among/);
    } finally {
      await db.executeRaw(`drop table ${table}`);
    }
  }, 60_000);

  // A value the native side cannot convert is reported as one the JS side
  // refuses: a TypeError, not a server error.
  it("gives a TypeError as the cause of a TSV value that cannot be converted", async () => {
    await recreate(KEYS, "(k int not null, v varchar(10) null)");
    const err = (await db
      .bulkInsert({ table: KEYS, rows: "1\ta\nnot-a-number\tb\n" })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(err.row).toBe(2);
    expect(await count(KEYS)).toBe(0);
  }, 60_000);

  it("refuses a float too small for its column rather than storing 0", async () => {
    const table = "tempdb..dsb_bcp_flt";
    await recreate(table, "(k int not null, f float null, r real null)");
    try {
      await expect(db.bulkInsert({ table, rows: "1\t1e-400\t\n" })).rejects.toThrow(
        /too small for the column: it would be stored as 0/
      );
      await expect(db.bulkInsert({ table, rows: "2\t\t1e-100\n" })).rejects.toThrow(
        /too small for the column/
      );
      // A small value the column can hold, and zero itself, are fine.
      await db.bulkInsert({ table, rows: "3\t1e-300\t0\n" });
      expect((await db.executeRaw(`select f, r from ${table}`)).rows).toEqual([
        { f: 1e-300, r: 0 }
      ]);
    } finally {
      await db.executeRaw(`drop table ${table}`);
    }
  }, 60_000);

  // A default of NULL is no default: a NULL stays NULL.
  it("copies NULL into a column whose default is NULL", async () => {
    const table = "tempdb..dsb_bcp_dnull";
    await recreate(table, "(k int not null, v varchar(10) default null null)");
    try {
      expect(
        (
          await db.bulkInsert({
            table,
            rows: [
              [1, null],
              [2, "x"]
            ]
          })
        ).rowsCopied
      ).toBe(2);
      expect((await db.executeRaw(`select k, v from ${table} order by k`)).rows).toEqual([
        { k: 1, v: null },
        { k: 2, v: "x" }
      ]);
    } finally {
      await db.executeRaw(`drop table ${table}`);
    }
  }, 60_000);

  // The lock scheme is read for exactly the named object: owner.table and
  // db.owner.table once probed `owner.sysobjects`, missed the table, and sent
  // the allpages row format to a datarows table (Msg 4837).
  it("copies into a datarows table named with its owner", async () => {
    const temp = createSybaseDrizzle({
      ...config,
      database: "tempdb",
      max: 1,
      warnOnTimeZoneMismatch: false
    } as Parameters<typeof createSybaseDrizzle>[0]);
    const table = "dsb_bcp_owned";
    try {
      await temp.executeRaw(`if object_id('${table}') is not null drop table ${table}`);
      await temp.executeRaw(
        `create table ${table} (k int not null, v varchar(10) null) lock datarows`
      );
      const [{ owner }] = (
        await temp.executeRaw<{ owner: string }>(
          `select user_name(uid) as owner from sysobjects where id = object_id('${table}')`
        )
      ).rows as [{ owner: string }];
      await temp.bulkInsert({ table: `${owner}.${table}`, rows: [[1, "a"]] });
      await temp.bulkInsert({ table: `tempdb.${owner}.${table}`, rows: [[2, "b"]] });
      expect((await temp.executeRaw(`select count(*) as n from ${table}`)).rows).toEqual([
        { n: 2 }
      ]);
    } finally {
      await temp.executeRaw(`if object_id('${table}') is not null drop table ${table}`);
      await temp.close();
    }
  }, 60_000);

  // After a batch commits, db-lib opens the copy again for the next one. When
  // that fails (here: the table was dropped the moment the commit released its
  // locks), what follows once went to the server as stray bulk packets. Now the
  // copy stops with the reason, the committed batch counted.
  it("stops with the reason when the copy cannot be opened again after a batch", async () => {
    const temp = createSybaseDrizzle({
      ...config,
      database: "tempdb",
      max: 2,
      warnOnTimeZoneMismatch: false
    } as Parameters<typeof createSybaseDrizzle>[0]);
    const table = "dsb_bcp_reopen";
    try {
      await temp.executeRaw(`if object_id('${table}') is not null drop table ${table}`);
      await temp.executeRaw(
        `create table ${table} (k int not null, pad varchar(1000) not null) lock datarows`
      );
      let dropped: Promise<unknown> | undefined;
      const pad = "x".repeat(1000);
      async function* rows() {
        for (let i = 0; i < 8_000; i++) {
          yield [i, pad];
        }
        // The copy is open (a first chunk was sent): the drop waits for its locks.
        dropped = temp.executeRaw(`drop table ${table}`);
        await new Promise(resolve => setTimeout(resolve, 1_500));
        for (let i = 8_000; i < 25_000; i++) {
          yield [i, pad];
        }
      }
      const err = (await temp
        .bulkInsert({ table, rows: rows(), batchSize: 20_000, maxErrors: 3_000 })
        .catch((e: unknown) => e)) as SybaseBulkCopyError;
      await dropped;
      expect(err).toBeInstanceOf(SybaseBulkCopyError);
      expect(err.message).toMatch(/could not be opened again after its last committed batch/);
      expect(err).toMatchObject({ rowsCommitted: 20_000, rowsInDoubt: 0, rejectedCount: 0 });
    } finally {
      await temp.executeRaw(`if object_id('${table}') is not null drop table ${table}`);
      await temp.close();
    }
  }, 120_000);

  // The JS layer queues calls on a connection; the exported native binding
  // does not, and a DBPROCESS must never run two calls at once.
  it("refuses a second native call on a connection while one is running", async () => {
    const handle = await native.connect({ ...config, timeout: 30 });
    try {
      const first = native.query(handle, "waitfor delay '00:00:01' select 1 as x");
      await expect(native.query(handle, "select 2 as y")).rejects.toThrow(/one call at a time/);
      await expect(
        native.bulkBegin(handle, { table: KEYS, hardTimeoutMs: 10_000 })
      ).rejects.toThrow(/one call at a time/);
      expect((await first).rows).toEqual([{ x: 1 }]);
      // Free again once the first has settled.
      expect((await native.query(handle, "select 3 as z")).rows).toEqual([{ z: 3 }]);
    } finally {
      native.close(handle);
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Deadlines
  // -------------------------------------------------------------------------

  // Rows of a batch already sent to the server, but not committed, are rolled
  // back: 25,000 rows of a 30,000-row batch, the first 10,000 of them sent, and
  // then the source stalls past the deadline.
  it("rolls back rows sent but not committed when the deadline passes", async () => {
    await recreate(KEYS, "(k int not null, v varchar(10) null) lock datarows");
    async function* rows() {
      for (let i = 0; i < 25_000; i++) {
        yield [i, "x"];
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    const sent: number[] = [];
    const binding = getNative();
    const send = binding.bulkSend;
    binding.bulkSend = (h, chunk) => {
      sent.push(chunk.rows);
      return send.call(binding, h, chunk);
    };
    try {
      const err = (await db
        .bulkInsert({ table: KEYS, rows: rows(), batchSize: 30_000, hardTimeoutMs: 4_000 })
        .catch((e: unknown) => e)) as SybaseBulkCopyError;
      expect(err).toBeInstanceOf(SybaseBulkCopyError);
      expect(err.rowsCommitted).toBe(0);
      // Rows did reach the server before the deadline...
      expect(sent[0]).toBe(10_000);
      // ...and none of them stayed.
      expect(await count(KEYS)).toBe(0);
    } finally {
      binding.bulkSend = send;
    }
  }, 60_000);

  it("rolls back the open batch when hardTimeoutMs passes in the middle of a load", async () => {
    await recreate(
      KEYS,
      "(k int not null, v varchar(10) null) lock datarows",
      `create unique index ux on ${KEYS} (k)`
    );
    async function* rows() {
      for (let i = 0; i < 3000; i++) {
        yield [i, "x"];
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
      yield [-1, "late"];
    }
    const started = Date.now();
    const err = (await db
      .bulkInsert({ table: KEYS, rows: rows(), batchSize: 1000, hardTimeoutMs: 3000 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(Date.now() - started).toBeLessThan(9000);
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.cause).toBeInstanceOf(SybaseTimeoutError);
    // Each full batch committed as soon as it was sent, before the stall.
    expect(err.rowsCommitted).toBe(3000);
    expect(err.rowsInDoubt).toBe(0);
    expect(await count(KEYS)).toBe(3000);
    // The pool replaced the abandoned connection.
    expect((await db.executeRaw("select 1 as x")).rows).toEqual([{ x: 1 }]);
  }, 60_000);

  it("times out cleanly while another session holds a lock it needs", async () => {
    await recreate(KEYS, "(k int not null, v varchar(10) null) lock datarows");
    await db.withConnection(async blocker => {
      // Taken once the copy has opened (rows are read after that), so that the
      // copy itself, not opening it, is what waits.
      async function* rows() {
        await blocker.executeRaw(`begin tran lock table ${KEYS} in exclusive mode`);
        for (let i = 0; i < 100; i++) {
          yield [i, "x"];
        }
      }
      try {
        const err = (await db
          .bulkInsert({ table: KEYS, rows: rows(), timeoutSeconds: 2 })
          .catch((e: unknown) => e)) as SybaseBulkCopyError;
        expect(err).toBeInstanceOf(SybaseBulkCopyError);
        expect(err.cause).toBeInstanceOf(SybaseTimeoutError);
        expect(err.rowsCommitted).toBe(0);
        // Either the wait was before the commit (nothing in doubt), or the
        // commit itself was cut off — and then the error says so.
        expect([0, 100]).toContain(err.rowsInDoubt);
      } finally {
        await blocker.executeRaw("rollback tran");
      }
    });
    expect(await count(KEYS)).toBe(0);
  }, 60_000);
});

describe.skipIf(!hasConfig)("per-query timeout (real ASE)", () => {
  let db: SybaseDrizzle;

  beforeAll(() => {
    db = createSybaseDrizzle({
      ...config,
      max: 3,
      timeout: 30,
      warnOnTimeZoneMismatch: false
    } as Parameters<typeof createSybaseDrizzle>[0]);
  });

  afterAll(async () => {
    await db.close();
  });

  it("fires a short timeout on a long waitfor while other connections keep their own", async () => {
    const timed = (promise: Promise<unknown>) => {
      const started = Date.now();
      return promise.then(
        value => ({ ok: true, value, ms: Date.now() - started }),
        (error: unknown) => ({ ok: false, error, ms: Date.now() - started })
      );
    };
    const [short, long] = await Promise.all([
      timed(db.executeRaw("waitfor delay '00:00:10'", { timeoutSeconds: 2 })),
      timed(db.executeRaw("waitfor delay '00:00:05' select 1 as x"))
    ]);
    expect(short.ok).toBe(false);
    expect((short as { error: unknown }).error).toBeInstanceOf(SybaseTimeoutError);
    expect((short as { error: SybaseTimeoutError }).error.timeoutMs).toBe(2000);
    expect(short.ms).toBeGreaterThanOrEqual(1900);
    expect(short.ms).toBeLessThan(8000);
    // The other connection's 5 s wait was not cut short by the 2 s timeout.
    expect(long).toMatchObject({ ok: true, value: { rows: [{ x: 1 }] } });
  }, 60_000);

  /**
   * A batch whose rows keep arriving: each step sends ~15 KB (several packets)
   * and then waits 0.6 s, so no single wait for the server comes near a 1 s
   * timeout however many steps there are. (ASE sends a packet once it is full,
   * not after each statement, hence the volume.)
   */
  const streaming = (steps: number) =>
    "create table #big (s char(250) not null)\n" +
    "declare @i int select @i = 0 " +
    "while @i < 60 begin insert #big values (replicate('x', 250)) select @i = @i + 1 end\n" +
    "select s from #big\nwaitfor delay '00:00:00.600'\n".repeat(steps) +
    "drop table #big";

  // timeoutSeconds limits each wait for the server, not the call: a caller
  // must budget a call on its hard timeout, not on timeoutSeconds.
  it("does not interrupt a query whose rows keep arriving, however long past timeoutSeconds", async () => {
    const started = Date.now();
    const result = await db.executeRaw(streaming(8), {
      timeoutSeconds: 1,
      hardTimeoutMs: 60_000,
      allResultSets: true
    });
    expect(Date.now() - started).toBeGreaterThan(4_000);
    expect(result.resultSets).toHaveLength(8);
    expect(result.resultSets!.every(set => set.length === 60)).toBe(true);
  }, 60_000);

  it("ends such a query at its hard timeout, which bounds the whole call", async () => {
    // A connection already open: opening one is not part of what is measured.
    await db.executeRaw("select 1 as x");
    const started = Date.now();
    const err = await db
      .executeRaw(streaming(40), { timeoutSeconds: 1, hardTimeoutMs: 4_000 })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(SybaseTimeoutError);
    expect((err as SybaseTimeoutError).timeoutMs).toBe(4_000);
    expect((err as Error).message).toMatch(/hard timeout of 4000 ms/);
    // Stopped by the hard timeout — not earlier by the 1 s cooperative one,
    // and not later than the hard timeout plus its one-second grace.
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(5_000);
    // The abandoned connection was replaced.
    expect((await db.executeRaw("select 1 as x")).rows).toEqual([{ x: 1 }]);
  }, 60_000);

  // A call blocked in one long wait (here a waitfor; in practice a lock) used
  // to hold its worker thread and its server session until the cooperative
  // timeout — 30 s here — long after its hard timeout. Now the worker drops
  // the connection within about a second of the hard timeout.
  it("releases a call blocked in one wait, and its server session, at the hard timeout", async () => {
    let spid = 0;
    // From when the statement is sent: taking (or opening) the connection is
    // not part of what is measured.
    let started = 0;
    let err: unknown;
    // The connection is gone after the callback: withConnection fails too.
    await expect(
      db.withConnection(async conn => {
        spid = Number((await conn.executeRaw<{ s: number }>("select @@spid as s")).rows[0]!.s);
        started = Date.now();
        err = await conn
          .executeRaw("waitfor delay '00:00:25'", { hardTimeoutMs: 2_000 })
          .catch((e: unknown) => e);
      })
    ).rejects.toThrow(/state could not be checked/);
    expect(err).toBeInstanceOf(SybaseTimeoutError);
    expect((err as SybaseTimeoutError).timeoutMs).toBe(2_000);
    expect((err as Error).message).toMatch(/hard timeout of 2000 ms/);
    // Settled within the hard timeout plus its one-second grace.
    expect(Date.now() - started).toBeLessThan(3_500);
    const alive = async () =>
      Number(
        (
          await db.executeRaw<{ n: number }>(
            `select count(*) as n from master..sysprocesses where spid = ${spid} ` +
              "and program_name = 'drizzle-sybase'"
          )
        ).rows[0]!.n
      );
    let n = await alive();
    for (let i = 0; n > 0 && i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      n = await alive();
    }
    expect(n).toBe(0);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 60_000);

  it("restores the connection's own timeout after a call that set its own", async () => {
    await db.withConnection(async conn => {
      await expect(
        conn.executeRaw("waitfor delay '00:00:04'", { timeoutSeconds: 1 })
      ).rejects.toBeInstanceOf(SybaseTimeoutError);
      // Same connection, no per-call timeout: the configured 30 s applies again.
      const { rows } = await conn.executeRaw("waitfor delay '00:00:03' select 2 as y");
      expect(rows).toEqual([{ y: 2 }]);
    });
  }, 60_000);
});

describe.skipIf(!hasConfig)("all result sets (real ASE)", () => {
  let db: SybaseDrizzle;

  beforeAll(() => {
    db = createSybaseDrizzle({ ...config, max: 2, warnOnTimeZoneMismatch: false } as Parameters<
      typeof createSybaseDrizzle
    >[0]);
  });

  afterAll(async () => {
    await db.close();
  });

  const batch =
    "create table #r (k int)\n" +
    "insert #r values (1) insert #r values (2)\n" +
    "select k from #r order by k\n" +
    "update #r set k = k + 10\n" +
    "select 'x' as s, convert(money, '1.5') as m\n" +
    "select k from #r where k < 0\n" +
    "drop table #r";

  it("returns every result set with columns, in order, when asked", async () => {
    const result = await db.executeRaw(batch, { allResultSets: true });
    expect(result.rows).toEqual([{ k: 1 }, { k: 2 }]);
    expect(result.resultSets).toEqual([[{ k: 1 }, { k: 2 }], [{ s: "x", m: "1.5000" }], []]);
  });

  it("keeps the first result set only by default, as before", async () => {
    const result = await db.executeRaw(batch);
    expect(result.rows).toEqual([{ k: 1 }, { k: 2 }]);
    expect("resultSets" in result).toBe(false);
  });

  it("caps each set at maxRows on its own, and works column by column", async () => {
    const result = await db.executeColumns(
      "select id from master..sysobjects select name from master..sysdatabases",
      { allResultSets: true, maxRows: 1 }
    );
    expect(result.resultSets).toHaveLength(2);
    expect(result.resultSets!.map(set => [set.rowCount, set.columns[0]!.name])).toEqual([
      [1, "id"],
      [1, "name"]
    ]);
  });

  it("is refused when writing to a file", async () => {
    await expect(
      db.executeToFile("select 1", { path: "/tmp/never.csv", allResultSets: true } as never)
    ).rejects.toThrow(/one result set/);
  });
});

/**
 * A TCP proxy between the driver and the server that cuts the connection at a
 * chosen point of a bulk copy, to see what the driver reports when the answer
 * to a commit is lost. It reads the TDS packet headers the client sends (type,
 * status, length): a bulk copy's rows travel as packets of type 7, and the
 * last packet of a batch (status bit 0x01) is what makes the server commit it.
 */
const TDS_BULK = 7;
const TDS_EOM = 1;

type CutAt =
  /** Forward the last packet of the `n`th batch, then cut: the server commits it, the answer is lost. */
  | { afterCommit: number }
  /** Cut instead of forwarding the last packet of the `n`th batch: nothing of it is committed. */
  | { beforeCommit: number }
  /** Cut at the first bulk packet: rows are still being sent. */
  | "duringRows";

const startProxy = async (target: { host: string; port: number }, cut: CutAt) => {
  const sockets = new Set<Socket>();
  const server: Server = createServer(client => {
    const upstream = connectTcp(target.port, target.host);
    sockets.add(client).add(upstream);
    let buffered = Buffer.alloc(0);
    let batches = 0;
    const kill = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= 8) {
        const length = buffered.readUInt16BE(2);
        if (buffered.length < length) {
          return;
        }
        const packet = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        const bulk = packet[0] === TDS_BULK;
        if (bulk && cut === "duringRows") {
          kill();
          return;
        }
        if (bulk && packet[1]! & TDS_EOM) {
          batches++;
          if (typeof cut === "object" && "beforeCommit" in cut && batches === cut.beforeCommit) {
            kill();
            return;
          }
          if (typeof cut === "object" && "afterCommit" in cut && batches === cut.afterCommit) {
            // Let the server read it all, then drop the connection before its answer.
            upstream.write(packet, () => setTimeout(kill, 50));
            client.pause();
            upstream.pause();
            return;
          }
        }
        upstream.write(packet);
      }
    });
    upstream.on("data", (data: Buffer) => client.write(data));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    close: () => {
      sockets.forEach(socket => socket.destroy());
      return new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
};

describe.skipIf(!hasConfig)(
  "connection lost during a bulk copy (real ASE, through a proxy)",
  () => {
    let db: SybaseDrizzle;
    const TABLE = "tempdb..dsb_bcp_lost";

    const count = async () =>
      Number((await db.executeRaw<{ n: number }>(`select count(*) as n from ${TABLE}`)).rows[0]!.n);

    /** Copy `rows` rows in batches of `batchSize` through a proxy that cuts at `cut`. */
    const copyThrough = async (cut: CutAt, rows: number, batchSize: number | "all") => {
      const proxy = await startProxy(config, cut);
      const viaProxy = createSybaseDrizzle({
        ...config,
        host: "127.0.0.1",
        port: proxy.port,
        max: 1,
        warnOnTimeZoneMismatch: false
      } as Parameters<typeof createSybaseDrizzle>[0]);
      try {
        return (await viaProxy
          .bulkInsert({
            table: TABLE,
            rows: Array.from({ length: rows }, (_, i) => [i, "x".repeat(100)]),
            batchSize
          })
          .catch((e: unknown) => e)) as SybaseBulkCopyError;
      } finally {
        await viaProxy.close();
        await proxy.close();
      }
    };

    beforeAll(async () => {
      db = createSybaseDrizzle({ ...config, max: 1, warnOnTimeZoneMismatch: false } as Parameters<
        typeof createSybaseDrizzle
      >[0]);
    });

    afterAll(async () => {
      await db
        .executeRaw(`if object_id('${TABLE}') is not null drop table ${TABLE}`)
        .catch(() => {});
      await db.close();
    });

    const fresh = async () => {
      await db.executeRaw(`if object_id('${TABLE}') is not null drop table ${TABLE}`);
      await db.executeRaw(
        `create table ${TABLE} (k int not null, v varchar(100) null) lock datarows`
      );
    };

    /** The server rolls back what a dropped connection left uncommitted, soon but not at once. */
    const settledCount = async () => {
      let last = -1;
      for (let i = 0; i < 20; i++) {
        const n = await count();
        if (n === last) {
          return n;
        }
        last = n;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return last;
    };

    it("reports a batch whose commit answer was lost as in doubt — here, committed", async () => {
      await fresh();
      const err = await copyThrough({ afterCommit: 2 }, 3000, 1000);
      expect(err).toBeInstanceOf(SybaseBulkCopyError);
      expect(err.rowsCommitted).toBe(1000);
      expect(err.batches).toEqual([{ rows: 1000 }]);
      expect(err.rowsInDoubt).toBe(1000);
      expect(err.message).toMatch(/the commit of the last batch \(1000 rows\) was under way/);
      // The server did get the whole batch: it committed. Only the answer was lost.
      expect(await settledCount()).toBe(2000);
    }, 60_000);

    it("reports a batch whose commit never reached the server as in doubt — here, not committed", async () => {
      await fresh();
      const err = await copyThrough({ beforeCommit: 1 }, 2000, "all");
      expect(err.rowsCommitted).toBe(0);
      expect(err.rowsInDoubt).toBe(2000);
      expect(await settledCount()).toBe(0);
    }, 60_000);

    it("reports nothing in doubt when the connection is lost while rows are still sent", async () => {
      await fresh();
      const err = await copyThrough("duringRows", 50_000, "all");
      expect(err).toBeInstanceOf(SybaseBulkCopyError);
      expect(err.rowsCommitted).toBe(0);
      expect(err.rowsInDoubt).toBe(0);
      expect(await settledCount()).toBe(0);
    }, 60_000);
  }
);
