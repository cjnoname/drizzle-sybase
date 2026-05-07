/**
 * Error handling integration tests.
 * Requires SYBASE_HOST, SYBASE_PORT, SYBASE_DATABASE, SYBASE_USERNAME, SYBASE_PASSWORD env vars.
 */
import { describe, it, expect, afterAll } from "vitest";

import { SybasePool } from "../src/connection.js";
import { SybaseError, SybaseConnectionError } from "../src/errors.js";
import { native } from "../src/native/index.js";

const config = {
  host: process.env.SYBASE_HOST ?? "",
  port: Number(process.env.SYBASE_PORT ?? "5000"),
  database: process.env.SYBASE_DATABASE ?? "",
  username: process.env.SYBASE_USERNAME ?? "",
  password: process.env.SYBASE_PASSWORD ?? ""
};

const hasConfig = config.host && config.database && config.username;

describe.skipIf(!hasConfig)("error handling", () => {
  let conn: unknown;

  afterAll(() => {
    if (conn) {
      native.close(conn);
    }
  });

  it("returns meaningful error for invalid SQL", async () => {
    conn = await native.connect(config);

    try {
      await native.query(conn, "SELECT * FROM this_table_definitely_does_not_exist_xyz");
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("Msg");
      expect(err.message).toContain("Level");
    }
  });

  it("returns meaningful error for syntax error", async () => {
    try {
      await native.query(conn, "SELCT broken syntax here");
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("Msg");
    }
  });

  it("recovers after an error (connection still usable)", async () => {
    const result = await native.query(conn, "SELECT 1 AS recovered");
    expect(result.rows[0].recovered).toBe(1);
  });
});

describe("SybaseError from pool (no real connection needed)", () => {
  it("rejects with SybaseError for bad host", async () => {
    const pool = new SybasePool({
      host: "nonexistent.invalid.host",
      port: 9999,
      database: "nope",
      username: "nobody",
      password: "wrong",
      min: 0,
      max: 1,
      timeout: 3,
      retries: 0
    });

    try {
      await pool.query("SELECT 1");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SybaseError);
      // Should specifically be a connection error
      expect(err).toBeInstanceOf(SybaseConnectionError);
    } finally {
      await pool.close();
    }
  });
});
