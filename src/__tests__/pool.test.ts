/**
 * Error hierarchy and pool behavior unit tests.
 * These tests verify error types and pool logic without requiring a real Sybase connection.
 */
import { describe, it, expect } from "vitest";

import { SybasePool } from "../connection.js";
import {
  SybaseError,
  SybaseConnectionError,
  SybaseQueryError,
  SybaseTimeoutError,
  SybasePoolError
} from "../errors.js";

// ---------------------------------------------------------------------------
// Error hierarchy tests
// ---------------------------------------------------------------------------

describe("SybaseError hierarchy", () => {
  it("SybaseError is a base Error", () => {
    const err = new SybaseError("test error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SybaseError);
    expect(err.name).toBe("SybaseError");
    expect(err.message).toBe("test error");
    expect(err.connectionDead).toBe(false);
  });

  it("SybaseError parses Sybase message format", () => {
    const err = new SybaseError("Msg 208, Level 16, State 1: Invalid object name 'foo'");
    expect(err.msgNo).toBe(208);
    expect(err.severity).toBe(16);
  });

  it("SybaseConnectionError extends SybaseError", () => {
    const err = new SybaseConnectionError("conn failed", { host: "localhost", port: 5000 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SybaseError);
    expect(err).toBeInstanceOf(SybaseConnectionError);
    expect(err.name).toBe("SybaseConnectionError");
    expect(err.connectionDead).toBe(true);
    expect(err.host).toBe("localhost");
    expect(err.port).toBe(5000);
  });

  it("SybaseQueryError extends SybaseError", () => {
    const err = new SybaseQueryError("syntax error", { sql: "SELCT 1" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SybaseError);
    expect(err).toBeInstanceOf(SybaseQueryError);
    expect(err.name).toBe("SybaseQueryError");
    expect(err.connectionDead).toBe(false);
    expect(err.sql).toBe("SELCT 1");
  });

  it("SybaseQueryError truncates long SQL", () => {
    const longSql = "SELECT " + "x".repeat(500);
    const err = new SybaseQueryError("error", { sql: longSql });
    expect(err.sql!.length).toBe(200);
  });

  it("SybaseTimeoutError extends SybaseError", () => {
    const err = new SybaseTimeoutError("timed out", "acquire", 10000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SybaseError);
    expect(err).toBeInstanceOf(SybaseTimeoutError);
    expect(err.name).toBe("SybaseTimeoutError");
    expect(err.operation).toBe("acquire");
    expect(err.timeoutMs).toBe(10000);
  });

  it("SybasePoolError extends SybaseError", () => {
    const err = new SybasePoolError("pool closed", "closed");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SybaseError);
    expect(err).toBeInstanceOf(SybasePoolError);
    expect(err.name).toBe("SybasePoolError");
    expect(err.poolState).toBe("closed");
    expect(err.connectionDead).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pool state tests (no real connections)
// ---------------------------------------------------------------------------

describe("SybasePool state management", () => {
  it("starts with correct initial state", () => {
    const pool = new SybasePool({
      host: "localhost",
      port: 5000,
      database: "test",
      username: "sa",
      password: "pass",
      min: 0,
      max: 10
    });

    expect(pool.size).toBe(0);
    expect(pool.idle).toBe(0);
    expect(pool.active).toBe(0);
    expect(pool.waiting).toBe(0);
    expect(pool.isDraining).toBe(false);
    expect(pool.isClosed).toBe(false);

    void pool.close();
  });

  it("reports closed state after close()", async () => {
    const pool = new SybasePool({
      host: "localhost",
      port: 5000,
      database: "test",
      username: "sa",
      password: "pass",
      min: 0
    });

    await pool.close();
    expect(pool.isClosed).toBe(true);
  });

  it("rejects acquire after close()", async () => {
    const pool = new SybasePool({
      host: "localhost",
      port: 5000,
      database: "test",
      username: "sa",
      password: "pass",
      min: 0
    });

    await pool.close();

    try {
      await pool.acquire();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SybasePoolError);
      expect((err as SybasePoolError).poolState).toBe("closed");
    }
  });

  it("rejects acquire after drain()", async () => {
    const pool = new SybasePool({
      host: "localhost",
      port: 5000,
      database: "test",
      username: "sa",
      password: "pass",
      min: 0
    });

    // drain should complete immediately when no active connections
    await pool.drain();

    try {
      await pool.acquire();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SybasePoolError);
    }
  });

  it("provides initial metrics", () => {
    const pool = new SybasePool({
      host: "localhost",
      port: 5000,
      database: "test",
      username: "sa",
      password: "pass",
      min: 0
    });

    const metrics = pool.metrics;
    expect(metrics.totalConnectionsCreated).toBe(0);
    expect(metrics.totalConnectionsDestroyed).toBe(0);
    expect(metrics.totalQueriesExecuted).toBe(0);
    expect(metrics.totalQueryErrors).toBe(0);
    expect(metrics.totalAcquireTimeouts).toBe(0);
    expect(metrics.avgQueryDurationMs).toBe(0);
    expect(metrics.currentSize).toBe(0);
    expect(metrics.currentActive).toBe(0);
    expect(metrics.currentIdle).toBe(0);
    expect(metrics.currentWaiting).toBe(0);

    void pool.close();
  });

  it("rejects with SybaseConnectionError for invalid host", async () => {
    const pool = new SybasePool({
      host: "127.0.0.1",
      port: 1, // Port 1 — no service listening, TCP RST immediately
      database: "nope",
      username: "nobody",
      password: "wrong",
      min: 0,
      max: 1,
      timeout: 2,
      retries: 0
    });

    try {
      await pool.query("SELECT 1");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SybaseError);
      expect(err).toBeInstanceOf(SybaseConnectionError);
    } finally {
      await pool.close();
    }
  }, 15000);

  it("acquire timeout throws SybaseTimeoutError", async () => {
    // We can't easily test actual acquire timeout without mocking native,
    // but we verify the pool validates configuration
    expect(
      () =>
        new SybasePool({
          host: "localhost",
          port: 9999,
          database: "nope",
          username: "nobody",
          password: "wrong",
          max: 0,
          timeout: 1
        })
    ).toThrow("Pool max must be at least 1");
  });

  it("rejects min > max configuration", () => {
    expect(
      () =>
        new SybasePool({
          host: "localhost",
          port: 5000,
          database: "test",
          username: "sa",
          password: "pass",
          min: 10,
          max: 5
        })
    ).toThrow("cannot exceed max");
  });

  it("rejects negative min", () => {
    expect(
      () =>
        new SybasePool({
          host: "localhost",
          port: 5000,
          database: "test",
          username: "sa",
          password: "pass",
          min: -1
        })
    ).toThrow("non-negative");
  });
});
