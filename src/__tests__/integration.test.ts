import { sql } from "drizzle-orm";
/**
 * Integration test — requires real Sybase connection.
 *
 * Set environment variables to run:
 *   SYBASE_HOST, SYBASE_PORT, SYBASE_DATABASE, SYBASE_USERNAME, SYBASE_PASSWORD
 *
 * Or create a .env.test file (not committed to git).
 */
import { describe, it, expect, afterAll } from "vitest";

import { SybasePool } from "../connection.js";
import { createSybaseDrizzle } from "../db.js";
import { native } from "../native/index.js";

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
      "SET ROWCOUNT 3\nSELECT name FROM sysobjects WHERE type = 'U' ORDER BY name\nSET ROWCOUNT 0"
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

  it("handles sequential queries on same connection", async () => {
    const r1 = await native.query(conn, "SELECT 1 AS a");
    const r2 = await native.query(conn, "SELECT 2 AS b");
    const r3 = await native.query(conn, "SELECT 3 AS c");
    expect(r1.rows[0].a).toBe(1);
    expect(r2.rows[0].b).toBe(2);
    expect(r3.rows[0].c).toBe(3);
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
      "SET ROWCOUNT 5\nSELECT name FROM sysobjects WHERE type = 'U' ORDER BY name\nSET ROWCOUNT 0"
    );
    expect(result.rows).toHaveLength(5);
  });

  it("execute with sql template works", async () => {
    const result = await db.execute(
      sql`SELECT COUNT(*) AS cnt FROM sysobjects WHERE type = ${"U"}`
    );
    expect(result.rows[0].cnt).toBeGreaterThan(0);
  });

  it("transaction works", async () => {
    await db.transaction(async tx => {
      const result = await tx.executeRaw("SELECT 99 AS in_tx");
      expect(result.rows[0].in_tx).toBe(99);
    });
  });
});
