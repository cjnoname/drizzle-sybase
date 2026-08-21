/**
 * Session wiring.
 *
 * `datetime.test.ts` covers the conversion itself; these tests cover the part
 * that is easy to get silently wrong — whether the configured zone actually
 * reaches the code that decodes rows, on every path (plain query, transaction)
 * and through `createSybaseDrizzle`.
 */
import { eq } from "drizzle-orm";
import { describe, it, expect } from "vitest";

import { datetime, money, varchar } from "../columns/index.js";
import type { QueryResult, SybasePoolConfig } from "../connection.js";
import { SybaseConnection, SybasePool } from "../connection.js";
import { createSybaseDrizzle } from "../db.js";
import { SybaseSession, SybaseTransactionSession } from "../session.js";
import { sybaseTable } from "../table.js";

const SYDNEY = "Australia/Sydney";

/** The canonical text `binding.c` produces for a datetime column. */
const STORED = "2016-06-09 09:48:46.753";
const AS_SYDNEY = "2016-06-08T23:48:46.753Z";
const AS_UTC = "2016-06-09T09:48:46.753Z";

const result = (overrides?: Partial<QueryResult>): QueryResult => ({
  rows: [{ dt_rec_added: STORED, title: "SOME SONG", tot_pr_royalty: "0.0000" }],
  columns: ["dt_rec_added", "title", "tot_pr_royalty"],
  columnTypes: ["datetime", "varchar", "money"],
  rowCount: 1,
  affectedRows: 0,
  ...overrides
});

/** Pool stub exposing only what the session touches. */
const fakePool = (queryResult: QueryResult = result()) => {
  const executed: string[] = [];
  const conn = {
    isConnected: true,
    query: async (sql: string) => {
      executed.push(sql);
      return queryResult;
    }
  } as unknown as SybaseConnection;
  const pool = {
    logger: undefined,
    query: async (sql: string) => {
      executed.push(sql);
      return queryResult;
    },
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

  it("decodes inside a transaction, with the zone the session was given", async () => {
    const { pool } = fakePool();
    const rows = await new SybaseSession(pool, SYDNEY).transaction(async tx => {
      const r = await tx.execute("select 1");
      return r.rows;
    });
    expect((rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_SYDNEY);
  });

  it("decodes on a transaction session's executeRaw", async () => {
    const { conn } = fakePool();
    const raw = await new SybaseTransactionSession(conn, undefined, SYDNEY).executeRaw("select 1");
    expect((raw.rows[0]!.dt_rec_added as Date).toISOString()).toBe(AS_SYDNEY);
  });

  it("surfaces a value the addon should never have produced", async () => {
    const { pool } = fakePool(result({ rows: [{ dt_rec_added: "Jun  9 2016 09:48:46:753AM" }] }));
    await expect(new SybaseSession(pool, SYDNEY).execute("select 1")).rejects.toThrow(
      /Could not decode datetime column/
    );
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
  const config = {
    host: "localhost",
    port: 5000,
    database: "db",
    username: "u",
    password: "p"
  };

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
});

describe("column mapping hooks", () => {
  const config = { host: "localhost", port: 5000, database: "db", username: "u", password: "p" };

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
