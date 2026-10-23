/**
 * Error hierarchy and pool behavior unit tests.
 * These tests verify error types and pool logic without requiring a real Sybase connection.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

import { SybaseConnection } from "../connection.js";
import {
  SybaseError,
  SybaseConnectionError,
  SybaseQueryError,
  SybaseTimeoutError,
  SybasePoolError
} from "../errors.js";
import { SybasePool } from "../pool.js";

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
      password: "pass"
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
      password: "pass"
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
      password: "pass"
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
      password: "pass"
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
});

// ---------------------------------------------------------------------------
// Pool behavior with a stubbed native layer
// ---------------------------------------------------------------------------

const base = { host: "h", port: 1, database: "d", username: "u", password: "p" };
const ok = { rows: [], columns: [], columnTypes: [], rowCount: 0, affectedRows: 0 };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Stub SybaseConnection's native-facing methods so nothing touches the addon.
 * Returns the set of currently open connections: a test kills one by deleting
 * it, and checks for leaks by its size.
 */
const stubConnections = (
  opts: {
    connectDelay?: number;
    onQuery?: (sql: string, conn: SybaseConnection) => Promise<unknown>;
    /** What the session reset reads back (default: nothing left open). */
    state?: Record<string, unknown>;
  } = {}
) => {
  const open = new Set<SybaseConnection>();
  vi.spyOn(SybaseConnection.prototype, "connect").mockImplementation(async function (
    this: SybaseConnection
  ) {
    if (opts.connectDelay) {
      await sleep(opts.connectDelay);
    }
    open.add(this);
  });
  vi.spyOn(SybaseConnection.prototype, "close").mockImplementation(function (
    this: SybaseConnection
  ) {
    open.delete(this);
  });
  vi.spyOn(SybaseConnection.prototype, "isConnected", "get").mockImplementation(function (
    this: SybaseConnection
  ) {
    return open.has(this);
  });
  vi.spyOn(SybaseConnection.prototype, "query").mockImplementation(async function (
    this: SybaseConnection,
    sql: string
  ) {
    const result = await (opts.onQuery ? opts.onQuery(sql, this) : ok);
    // Answer the pool's session reset like a server with nothing left open.
    if (sql.includes("@@trancount as tc")) {
      return { ...ok, rows: [opts.state ?? { tc: 0, ch: 0 }], rowCount: 1 } as any;
    }
    return result as any;
  });
  return open;
};

describe("SybasePool with stubbed connections", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not hand the same connection to two callers during a health check", async () => {
    stubConnections({ onQuery: () => sleep(10).then(() => ok) });
    const pool = new SybasePool({ ...base, max: 2, healthCheck: true });
    const first = await pool.acquire();
    pool.release(first);

    const [a, b] = await Promise.all([pool.acquire(), pool.acquire()]);
    expect(a).not.toBe(b);
    expect(pool.active).toBe(2);
    await pool.close();
  });

  it("does not retry a statement whose connection died mid-query", async () => {
    let runs = 0;
    const open = stubConnections({
      onQuery: async (sql, conn) => {
        if (sql === "insert") {
          runs++;
          open.delete(conn);
          throw new SybaseConnectionError("connection lost");
        }
        return ok;
      }
    });
    const pool = new SybasePool({ ...base, retries: 3, retryDelayMs: 0 });

    await expect(pool.query("insert")).rejects.toBeInstanceOf(SybaseConnectionError);
    expect(runs).toBe(1);
    await pool.close();
  });

  it("retries a read-only statement whose connection died mid-query", async () => {
    let runs = 0;
    const open = stubConnections({
      onQuery: async (sql, conn) => {
        if (sql === "select 1" && ++runs === 1) {
          open.delete(conn);
          throw new SybaseConnectionError("connection lost");
        }
        return ok;
      }
    });
    const pool = new SybasePool({ ...base, retries: 3, retryDelayMs: 0 });

    await expect(pool.query("select 1")).resolves.toEqual(ok);
    expect(runs).toBe(2);
    await pool.close();
  });

  // Nothing reached the server when the connection could not be opened, so
  // retrying is safe even for a write.
  it("retries any statement when opening a connection fails", async () => {
    stubConnections();
    let attempts = 0;
    const spy = vi.mocked(SybaseConnection.prototype.connect);
    const stubbed = spy.getMockImplementation()!;
    spy.mockImplementation(async function (this: SybaseConnection) {
      if (++attempts === 1) {
        throw new SybaseConnectionError("connect refused");
      }
      return stubbed.call(this);
    });
    const pool = new SybasePool({ ...base, retries: 1, retryDelayMs: 0 });

    await expect(pool.query("insert")).resolves.toEqual(ok);
    expect(attempts).toBe(2);
    await pool.close();
  });

  it("gives up on connect failures after the configured retries", async () => {
    stubConnections();
    vi.spyOn(SybaseConnection.prototype, "connect").mockRejectedValue(
      new SybaseConnectionError("connect refused")
    );
    const pool = new SybasePool({ ...base, retries: 2, retryDelayMs: 0 });

    await expect(pool.query("insert")).rejects.toBeInstanceOf(SybaseConnectionError);
    expect(SybaseConnection.prototype.connect).toHaveBeenCalledTimes(3);
    await pool.close();
  });

  it("resets the session after a failed statement", async () => {
    const executed: string[] = [];
    stubConnections({
      onQuery: async sql => {
        executed.push(sql);
        if (sql.startsWith("begin tran")) {
          throw new SybaseQueryError("Msg 2601");
        }
        return ok;
      }
    });
    const pool = new SybasePool({ ...base, retries: 0 });

    await expect(pool.query("begin tran insert t values (1)")).rejects.toThrow("Msg 2601");
    expect(executed.at(-1)).toContain("if @@trancount > 0 rollback tran");
    expect(pool.size).toBe(1);
    await pool.close();
  });

  // Each pool query may land on another connection, so nothing could ever
  // commit it; left open it would hold its locks and absorb the next user's
  // writes into a transaction that is never committed.
  it("rolls back and reports a transaction a successful raw batch left open", async () => {
    const executed: string[] = [];
    stubConnections({
      onQuery: async sql => {
        executed.push(sql);
        return ok;
      },
      state: { tc: 1, ch: 0 }
    });
    const pool = new SybasePool({ ...base });

    await expect(pool.query("begin tran insert t values (1)")).rejects.toThrow(
      /left a transaction open/
    );
    expect(executed.at(-1)).toContain("if @@trancount > 0 rollback tran");
    expect(pool.metrics.totalQueryErrors).toBe(0);
    await pool.close();
  });

  it("resets quietly after a raw SET that left nothing open", async () => {
    const executed: string[] = [];
    stubConnections({
      onQuery: async sql => {
        executed.push(sql);
        return ok;
      }
    });
    const pool = new SybasePool({ ...base });

    await expect(pool.query("set rowcount 5")).resolves.toEqual(ok);
    expect(executed).toHaveLength(2);
    await pool.close();
  });

  it("discards the connection when the state after a raw batch cannot be read", async () => {
    stubConnections({ state: { tc: null, ch: 0 } });
    const pool = new SybasePool({ ...base });

    await expect(pool.query("exec sp_who")).rejects.toThrow(/could not be verified/);
    expect(pool.size).toBe(0);
    await pool.close();
  });

  it("adds no round-trip for statements that cannot change session state", async () => {
    const executed: string[] = [];
    stubConnections({
      onQuery: async sql => {
        executed.push(sql);
        return ok;
      }
    });
    const pool = new SybasePool({ ...base });

    for (const sql of [
      // How the select builder paginates.
      "select top 10 * from [t]",
      "insert into [t] ([a]) values (1)\nSELECT @@identity",
      "update [t] set [a] = 1 where [b] = 'begin tran'",
      "delete from [t]"
    ]) {
      await pool.query(sql);
    }
    expect(executed).toHaveLength(4);
    await pool.close();
  });

  it("releases the connection when the logger throws", async () => {
    stubConnections();
    const pool = new SybasePool({
      ...base,
      max: 1,
      acquireTimeoutMs: 50,
      logger: {
        query() {
          throw new Error("logger broke");
        }
      }
    });

    await expect(pool.query("select 1")).resolves.toEqual(ok);
    expect(pool.active).toBe(0);
    await pool.close();
  });

  it("discards a connection whose ROWCOUNT reset failed", async () => {
    const open = stubConnections({ onQuery: () => Promise.reject(new Error("fail")) });
    const pool = new SybasePool({ ...base });

    await expect(pool.query("select 1")).rejects.toThrow("fail");
    expect(pool.size).toBe(0);
    expect(open.size).toBe(0);
    await pool.close();
  });
});

describe("SybasePool acquire deadline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // acquireTimeoutMs bounds the whole acquire, not only time spent queued.
  it("times out while a connection is still being opened", async () => {
    const open = stubConnections({ connectDelay: 200 });
    const pool = new SybasePool({ ...base, max: 1, acquireTimeoutMs: 30 });
    const started = Date.now();
    await expect(pool.acquire()).rejects.toBeInstanceOf(SybaseTimeoutError);
    expect(Date.now() - started).toBeLessThan(150);
    expect(pool.metrics.totalAcquireTimeouts).toBe(1);

    // The connection that arrives late is not lost: it is idle in the pool.
    await sleep(250);
    expect(open.size).toBe(1);
    expect(pool.size).toBe(1);
    expect(pool.idle).toBe(1);
    await pool.close();
  });

  // The failed attempt's slot is free again; a queued caller should try it now
  // rather than wait out its own timeout.
  it("gives a queued caller its own attempt when a connect fails", async () => {
    stubConnections({ connectDelay: 20 });
    const spy = vi.mocked(SybaseConnection.prototype.connect);
    const stubbed = spy.getMockImplementation()!;
    let attempts = 0;
    spy.mockImplementation(async function (this: SybaseConnection) {
      if (++attempts === 1) {
        await sleep(20);
        throw new SybaseConnectionError("connect refused");
      }
      return stubbed.call(this);
    });
    const pool = new SybasePool({ ...base, max: 1, acquireTimeoutMs: 5_000 });

    const first = pool.acquire();
    const second = pool.acquire();
    await expect(first).rejects.toBeInstanceOf(SybaseConnectionError);
    const started = Date.now();
    const conn = await second;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(attempts).toBe(2);
    pool.release(conn);
    await pool.close();
  });
});

describe("pool configuration validation", () => {
  it.each([
    ["max", { max: Number.NaN }],
    ["max", { max: 1.5 }],
    ["max", { max: Infinity }]
  ])("rejects %s %j", (_name, bad) => {
    expect(() => new SybasePool({ ...base, ...bad })).toThrow(SybasePoolError);
  });

  // Each of these would otherwise fail silently: NaN breaks pool arithmetic,
  // and timers treat anything past 2^31-1 ms as 1 ms.
  it.each([
    { port: 0 },
    { port: 70_000 },
    { timeout: -1 },
    { timeout: 2_000_000 },
    { packetSize: 100 },
    { hardTimeoutMs: 0 },
    { idleTimeoutMs: Number.NaN },
    { acquireTimeoutMs: 2 ** 31 },
    { cleanupIntervalMs: 0 },
    { retries: -1 },
    { retries: 0.5 },
    { retryDelayMs: -5 }
  ])("rejects %j", bad => {
    expect(() => new SybasePool({ ...base, ...bad })).toThrow(RangeError);
  });

  it("validates a standalone connection's options too", () => {
    expect(() => new SybaseConnection({ ...base, port: Number.NaN })).toThrow(RangeError);
  });

  it.each([{ maxRows: 0 }, { maxRows: 1.5 }, { hardTimeoutMs: -1 }])(
    "rejects query option %j before acquiring",
    async bad => {
      stubConnections();
      const pool = new SybasePool({ ...base });
      await expect(pool.query("select 1", bad)).rejects.toThrow(RangeError);
      expect(pool.size).toBe(0);
      await pool.close();
      vi.restoreAllMocks();
    }
  );
});

describe("SybasePool identity changes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The original identity may lack the permission to switch back, so the
  // connection cannot be restored — only discarded.
  it.each([
    ["succeeds", false],
    ["fails", true]
  ])("discards a connection whose setuser batch %s", async (_name, fail) => {
    stubConnections({
      onQuery: async sql => {
        if (fail && sql.startsWith("setuser")) {
          throw new SybaseQueryError("Msg 10353");
        }
        return ok;
      }
    });
    const pool = new SybasePool({ ...base, retries: 0 });
    const run = pool.query("setuser 'app'\nselect 1");
    await (fail ? expect(run).rejects.toThrow() : expect(run).resolves.toEqual(ok));
    expect(pool.size).toBe(0);
    await pool.close();
  });
});

describe("SybasePool close races", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes a connection that finishes opening after the pool closed", async () => {
    const open = stubConnections({ connectDelay: 20 });
    const pool = new SybasePool({ ...base });

    const pending = pool.acquire();
    await pool.close();

    await expect(pending).rejects.toBeInstanceOf(SybasePoolError);
    expect(open.size).toBe(0);
  });

  it("does not hand out a connection whose health check outlived the pool", async () => {
    const open = stubConnections({ onQuery: () => sleep(20).then(() => ok) });
    const pool = new SybasePool({ ...base, healthCheck: true });
    pool.release(await pool.acquire());

    const pending = pool.acquire();
    await pool.close();

    await expect(pending).rejects.toBeInstanceOf(SybasePoolError);
    expect(open.size).toBe(0);
  });

  it("closes a connection created for a waiter after the pool closed", async () => {
    const open = stubConnections({ connectDelay: 20 });
    const pool = new SybasePool({ ...base, max: 1, acquireTimeoutMs: 1000 });
    const first = await pool.acquire();
    const waiting = pool.acquire();

    // Dead on release -> pool opens a replacement for the waiter.
    open.delete(first);
    pool.release(first);
    await pool.close();

    await expect(waiting).rejects.toBeInstanceOf(SybasePoolError);
    await sleep(40);
    expect(open.size).toBe(0);
  });
});

describe("SybasePool drain completion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finishes drain when the last active connection dies", async () => {
    const open = stubConnections();
    const pool = new SybasePool({ ...base });
    const conn = await pool.acquire();

    const drained = pool.drain(60_000);
    open.delete(conn);
    pool.release(conn);

    await drained;
    expect(pool.isClosed).toBe(true);
  });

  it("settles every concurrent drain() when the last connection is released", async () => {
    stubConnections();
    const pool = new SybasePool({ ...base });
    const conn = await pool.acquire();

    const settled: number[] = [];
    const first = pool.drain(60_000).then(() => settled.push(1));
    const second = pool.drain(60_000).then(() => settled.push(2));
    pool.release(conn);
    await Promise.all([first, second]);

    expect(settled.toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(pool.isClosed).toBe(true);
  });

  it("settles a pending drain() when close() is called directly", async () => {
    stubConnections();
    const pool = new SybasePool({ ...base });
    await pool.acquire();

    const drained = pool.drain(60_000);
    await pool.close();
    await drained;
  });

  it("finishes drain when a health check fails on the last active connection", async () => {
    let failCheck!: (err: Error) => void;
    stubConnections({ onQuery: () => new Promise((_, reject) => (failCheck = reject)) });
    const pool = new SybasePool({ ...base, healthCheck: true });
    // Seed one idle connection without going through the health check.
    (pool as any).cfg.healthCheck = false;
    pool.release(await pool.acquire());
    (pool as any).cfg.healthCheck = true;

    const acquiring = pool.acquire();
    const drained = pool.drain(60_000);
    failCheck(new Error("health check failed"));

    await expect(acquiring).rejects.toBeInstanceOf(SybasePoolError);
    await drained;
    expect(pool.isClosed).toBe(true);
  });
});
