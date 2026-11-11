/**
 * SybaseConnection lifecycle against a stubbed native layer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  opened,
  pending,
  server,
  queries,
  queryOptions,
  queryFailure,
  connectConfigs,
  connectError
} = vi.hoisted(() => ({
  opened: new Set<object>(),
  pending: [] as (() => void)[],
  /** Rows the stubbed server answers to the session-state queries. */
  server: {
    init: [{ iso: 1 }] as Record<string, unknown>[],
    state: [{ tc: 0, ch: 0 }] as Record<string, unknown>[],
    /** When set, the session-init query waits for it. */
    initGate: undefined as Promise<void> | undefined,
    /** When set, a query whose SQL contains `sql` waits for `gate`. */
    queryGate: undefined as { sql: string; gate: Promise<void> } | undefined
  },
  queries: [] as string[],
  /** Options each query was given, in order. */
  queryOptions: [] as (Record<string, unknown> | undefined)[],
  /** When set, a query whose SQL contains `sql` rejects with `error`. */
  queryFailure: { current: undefined as { sql: string; error: Error } | undefined },
  connectConfigs: [] as Record<string, unknown>[],
  /** When set, connect() rejects with this message. */
  connectError: { message: undefined as string | undefined }
}));

vi.mock("../native/index.js", () => ({
  native: {
    connect: (cfg: Record<string, unknown>) =>
      new Promise((resolve, reject) =>
        pending.push(() => {
          connectConfigs.push(cfg);
          if (connectError.message) {
            reject(new Error(connectError.message));
            return;
          }
          const handle = {};
          opened.add(handle);
          resolve(handle);
        })
      ),
    query: async (_handle: object, sql: string, options?: Record<string, unknown>) => {
      queries.push(sql);
      queryOptions.push(options);
      if (server.queryGate && sql.includes(server.queryGate.sql)) {
        await server.queryGate.gate;
      }
      if (queryFailure.current && sql.includes(queryFailure.current.sql)) {
        throw queryFailure.current.error;
      }
      if (sql.includes("@@isolation as iso") && server.initGate) {
        await server.initGate;
      }
      const rows = sql.includes("@@isolation as iso")
        ? server.init
        : sql.includes("@@trancount as tc")
          ? server.state
          : [];
      return { rows, columns: [], columnTypes: [], rowCount: rows.length, affectedRows: 0 };
    },
    close: (handle: object) => opened.delete(handle),
    isAlive: (handle: object) => opened.has(handle),
    serverCharset: () => "iso_1"
  }
}));

import { SybaseConnection } from "../connection.js";
import { SybaseConnectionError, SybaseTimeoutError } from "../errors.js";

const config = { host: "h", port: 1, database: "d", username: "u", password: "p" };
const settle = () => pending.splice(0).forEach(open => open());

const connected = async () => {
  const conn = new SybaseConnection(config);
  const connecting = conn.connect();
  settle();
  await connecting;
  return conn;
};

afterEach(() => {
  opened.clear();
  pending.length = 0;
  queries.length = 0;
  queryOptions.length = 0;
  queryFailure.current = undefined;
  connectConfigs.length = 0;
  connectError.message = undefined;
  server.init = [{ iso: 1 }];
  server.state = [{ tc: 0, ch: 0 }];
  server.initGate = undefined;
  server.queryGate = undefined;
});

describe("a call outliving its connection", () => {
  const reconnect = async (conn: SybaseConnection) => {
    conn.close();
    const connecting = conn.connect();
    settle();
    await connecting;
  };

  // A call's failure closes its own handle: after a reconnect, that is no
  // longer the connection's.
  it("does not close the connection opened since when it fails", async () => {
    const conn = await connected();
    let release!: () => void;
    server.queryGate = { sql: "slow", gate: new Promise(resolve => (release = resolve)) };
    const slow = conn.query("select slow").catch((e: unknown) => e);
    await vi.waitFor(() => expect(queries).toContain("select slow"));
    await reconnect(conn);
    queryFailure.current = {
      sql: "slow",
      error: Object.assign(new Error("gone"), { connectionDead: true })
    };
    release();
    expect(await slow).toBeInstanceOf(SybaseConnectionError);
    expect(conn.isConnected).toBe(true);
  });

  // Queued before the close, a statement was meant for that session: it does
  // not run on the next one.
  it("does not run a call queued before a close on the connection opened since", async () => {
    const conn = await connected();
    let release!: () => void;
    server.queryGate = { sql: "slow", gate: new Promise(resolve => (release = resolve)) };
    const slow = conn.query("select slow");
    const queued = conn.query("insert t values (1)").catch((e: unknown) => e);
    await vi.waitFor(() => expect(queries).toContain("select slow"));
    await reconnect(conn);
    release();
    await slow;
    expect(await queued).toBeInstanceOf(SybaseConnectionError);
    expect(queries).not.toContain("insert t values (1)");
    expect(conn.isConnected).toBe(true);
  });
});

describe("SybaseConnection.connect", () => {
  it("shares one native connect between concurrent callers", async () => {
    const conn = new SybaseConnection(config);
    const both = Promise.all([conn.connect(), conn.connect()]);
    settle();
    await both;

    expect(opened.size).toBe(1);
    conn.close();
    expect(opened.size).toBe(0);
  });

  it("closes a handle that arrives after close()", async () => {
    const conn = new SybaseConnection(config);
    const connecting = conn.connect();
    conn.close();
    settle();

    await expect(connecting).rejects.toBeInstanceOf(SybaseConnectionError);
    expect(opened.size).toBe(0);
    expect(conn.isConnected).toBe(false);
  });

  // The handle exists but is not stored yet while the session is initialised,
  // so close() cannot reach it: connect() must close it itself.
  it("closes a handle whose session initialisation outlives close()", async () => {
    let finishInit!: () => void;
    server.initGate = new Promise<void>(resolve => (finishInit = resolve));
    const conn = new SybaseConnection(config);
    const connecting = conn.connect();
    settle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened.size).toBe(1);
    conn.close();
    finishInit();

    await expect(connecting).rejects.toThrow(/closed while connecting/);
    expect(opened.size).toBe(0);
    expect(conn.isConnected).toBe(false);
  });

  // A login trigger can turn chained mode on, where every pooled statement
  // would open a transaction nothing commits.
  it("turns chained mode off and records the isolation level it finds", async () => {
    server.init = [{ iso: 0 }];
    const conn = await connected();
    expect(queries[0]).toContain("if @@tranchained = 1 set chained off");
    await conn.resetSessionState();
    expect(queries.at(-1)).toContain("SET TRANSACTION ISOLATION LEVEL 0");
  });

  it.each([
    ["no row", []],
    ["NULL", [{ iso: null }]],
    ["an unknown level", [{ iso: 7 }]]
  ])("refuses a session whose isolation level reads as %s", async (_name, rows) => {
    server.init = rows;
    const conn = new SybaseConnection(config);
    const connecting = conn.connect();
    settle();
    await expect(connecting).rejects.toThrow(/isolation level/);
    expect(opened.size).toBe(0);
  });
});

describe("server time zone check", () => {
  const open = async (host: string, timeZone?: string) => {
    const conn = new SybaseConnection({ ...config, host, ...(timeZone ? { timeZone } : {}) });
    const connecting = conn.connect();
    settle();
    await connecting;
    return conn;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Every datetime would silently be off by the difference.
  it("warns once per server and zone when the server's clock is elsewhere", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    server.init = [{ iso: 1, tz: 660 * 60 }];
    await open("tz-a");
    await open("tz-a");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/off by 11 hours/);
    expect(warn.mock.calls[0]![1]).toEqual({ code: "DRIZZLE_SYBASE_TIMEZONE" });
  });

  // Introspection reads no datetime value: a warning there is only noise.
  it("stays quiet when told the connection reads no datetimes", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    server.init = [{ iso: 1, tz: 660 * 60 }];
    const conn = new SybaseConnection({ ...config, host: "tz-g", warnOnTimeZoneMismatch: false });
    const connecting = conn.connect();
    settle();
    await connecting;
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet when the configured zone matches the server", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    server.init = [{ iso: 1, tz: 0 }];
    await open("tz-b");
    await open("tz-c", "UTC");
    expect(warn).not.toHaveBeenCalled();
  });

  // getdate() and getutcdate() are read an instant apart; across a second
  // boundary the difference is a second short of the true offset.
  it("tolerates the two clocks being read a second apart", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const sydneyNow = Math.round(
      (Date.parse(
        new Date().toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).replace(" ", "T") + "Z"
      ) -
        Date.now()) /
        60_000
    );
    server.init = [{ iso: 1, tz: sydneyNow * 60 - 1 }];
    await open("tz-e", "Australia/Sydney");
    server.init = [{ iso: 1, tz: sydneyNow * 60 + 1 }];
    await open("tz-f", "Australia/Sydney");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fail the connection when the offset cannot be read", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    server.init = [{ iso: 1, tz: null }];
    await expect(open("tz-d")).resolves.toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("SybaseConnection.resetSessionState", () => {
  it("restores the baseline in one batch and reports a clean session", async () => {
    server.init = [{ iso: 2 }];
    const conn = await connected();
    await expect(conn.resetSessionState()).resolves.toEqual({ leftOpen: false });
    const reset = queries.at(-1)!;
    expect(reset).toContain("SET ROWCOUNT 0");
    expect(reset).toContain("if @@trancount > 0 rollback tran");
    expect(reset).toContain("if @@tranchained = 1 set chained off");
    expect(reset).toContain("SET TRANSACTION ISOLATION LEVEL 2");
    // A raw `use` must not leave the next user in another database.
    expect(reset).toContain("use [d]");
  });

  it.each([
    ["an open transaction", { tc: 1, ch: 0 }],
    ["chained mode", { tc: 0, ch: 1 }]
  ])("reports %s it undid", async (_name, state) => {
    const conn = await connected();
    server.state = [state];
    await expect(conn.resetSessionState()).resolves.toEqual({ leftOpen: true });
  });

  it("rejects when the state cannot be read", async () => {
    const conn = await connected();
    server.state = [{ tc: null, ch: 0 }];
    await expect(conn.resetSessionState()).rejects.toThrow(/session state/);
  });
});

describe("TDS packet size", () => {
  // ASE's default `max network packet size` is 2048, and a larger request is
  // refused outright, so the default must not exceed it.
  it("asks for 2048 bytes by default", async () => {
    const conn = new SybaseConnection(config);
    const connecting = conn.connect();
    settle();
    await connecting;
    expect(connectConfigs[0]!.packetSize).toBe(2048);
  });

  // The server refuses an oversized packet with the bad-credentials message.
  it("points at the packet size when a larger one is refused", async () => {
    connectError.message = "Failed to connect to h:1: Msg 4002, Level 14, State 1: Login failed.";
    const conn = new SybaseConnection({ ...config, packetSize: 4096 });
    const connecting = conn.connect();
    settle();
    await expect(connecting).rejects.toThrow(/packetSize is 4096.*max network packet size/);
  });

  // A server can be configured down to 512, so the default can be refused too.
  it("points at the packet size when the default is refused", async () => {
    connectError.message = "Failed to connect to h:1: Msg 4002, Level 14, State 1: Login failed.";
    const conn = new SybaseConnection(config);
    const connecting = conn.connect();
    settle();
    await expect(connecting).rejects.toThrow(/packetSize is 2048/);
  });

  // 512 is the lowest limit a server can have: never the cause.
  it("does not blame a 512-byte packet for a failed login", async () => {
    connectError.message = "Failed to connect to h:1: Msg 4002, Level 14, State 1: Login failed.";
    const conn = new SybaseConnection({ ...config, packetSize: 512 });
    const connecting = conn.connect();
    settle();
    const err = await connecting.catch((e: Error) => e);
    expect(String(err)).not.toMatch(/packetSize/);
  });
});

describe("per-query timeout", () => {
  it("hands timeoutSeconds to the native query, leaving the hard timeout derived from it", async () => {
    const conn = await connected();
    await conn.query("waitfor delay '00:00:01'", { timeoutSeconds: 5 });
    expect(queryOptions.at(-1)).toEqual({ timeoutSeconds: 5 });
  });

  // The configured hard timeout belongs to the configured timeout: a call with
  // its own timeout gets its own 2x default, as the native side computes it.
  it("does not apply the configured hardTimeoutMs to a call with its own timeout", async () => {
    const conn = new SybaseConnection({ ...config, hardTimeoutMs: 600_000 });
    const connecting = conn.connect();
    settle();
    await connecting;
    await conn.query("select 1", { timeoutSeconds: 20 });
    expect(queryOptions.at(-1)).toEqual({ timeoutSeconds: 20 });
    await conn.query("select 1");
    expect(queryOptions.at(-1)).toEqual({ hardTimeoutMs: 600_000 });
  });

  it("keeps an explicit hardTimeoutMs", async () => {
    const conn = await connected();
    await conn.query("select 1", { timeoutSeconds: 3, hardTimeoutMs: 9_000 });
    expect(queryOptions.at(-1)).toEqual({ timeoutSeconds: 3, hardTimeoutMs: 9_000 });
  });

  it("reports the call's own timeout when it fires", async () => {
    const conn = await connected();
    queryFailure.current = {
      sql: "waitfor",
      error: Object.assign(new Error("DB-Lib error 20003: TDS server connection timed out"), {
        timedOut: true
      })
    };
    const err = await conn
      .query("waitfor delay '00:01:00'", { timeoutSeconds: 2 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SybaseTimeoutError);
    expect((err as SybaseTimeoutError).timeoutMs).toBe(2_000);
    // A cooperative timeout cancels the statement, not the connection.
    expect(conn.isConnected).toBe(true);
  });

  it("passes timeoutSeconds through queryColumns and queryToFile", async () => {
    const conn = await connected();
    const columns = vi.fn(async () => ({ columns: [], rowCount: 0, affectedRows: 0 }));
    const file = vi.fn(async () => ({
      columns: [],
      columnTypes: [],
      rowCount: 0,
      affectedRows: 0,
      bytes: 0
    }));
    const { native } = await import("../native/index.js");
    Object.assign(native, { queryColumns: columns, queryToFile: file });
    await conn.queryColumns("select 1", { timeoutSeconds: 4 });
    await conn.queryToFile("select 1", { timeoutSeconds: 6, path: "/tmp/x.csv" });
    expect(columns.mock.calls[0]).toEqual([expect.anything(), "select 1", { timeoutSeconds: 4 }]);
    expect(file.mock.calls[0]).toEqual([
      expect.anything(),
      "select 1",
      { maxRows: undefined, timeoutSeconds: 6, hardTimeoutMs: undefined, path: "/tmp/x.csv" }
    ]);
  });

  it.each([0, -1, 1.5, 1_073_742])("rejects timeoutSeconds %s", async value => {
    const conn = await connected();
    await expect(conn.query("select 1", { timeoutSeconds: value })).rejects.toThrow(RangeError);
  });
});

describe("hard timeout bound", () => {
  // The native watchdog normally answers first; if the worker never does
  // (blocked in one wait, or queued behind a full libuv pool), the call still
  // settles one second after its hard timeout — the bound callers budget on.
  it("settles a call the native side never answers at hardTimeoutMs plus one second", async () => {
    const conn = await connected();
    const { native } = await import("../native/index.js");
    const query = native.query;
    Object.assign(native, { query: () => new Promise(() => {}) });
    try {
      const started = Date.now();
      const err = await conn.query("select 1", { hardTimeoutMs: 200 }).catch((e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(err).toBeInstanceOf(SybaseTimeoutError);
      expect(err).toMatchObject({ connectionDead: true });
      expect(elapsed).toBeGreaterThanOrEqual(1_150);
      expect(elapsed).toBeLessThan(1_800);
      expect(conn.isConnected).toBe(false);
    } finally {
      Object.assign(native, { query });
    }
  });
});

describe("hard timeout at its largest", () => {
  // hardTimeoutMs plus the JS grace must not pass setTimeout's 2^31-1 ms limit,
  // past which Node fires the timer after 1 ms.
  it("does not time a call out at once when hardTimeoutMs is the largest allowed", async () => {
    const conn = await connected();
    const { native } = await import("../native/index.js");
    const query = native.query;
    Object.assign(native, {
      query: () =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve({
                rows: [{ x: 1 }],
                columns: [],
                columnTypes: [],
                rowCount: 1,
                affectedRows: 0
              }),
            50
          )
        )
    });
    try {
      const result = await conn.query("select 1", { hardTimeoutMs: 2_147_483_647 });
      expect(result.rows).toEqual([{ x: 1 }]);
      expect(conn.isConnected).toBe(true);
    } finally {
      Object.assign(native, { query });
    }
  });
});

describe("a call that leaves the connection unusable", () => {
  // Marking it closed is not enough: without a pool to close it, the native
  // connection (and its server session) would stay open until GC.
  it.each([
    ["its hard timeout fired", { hardTimeout: true, connectionDead: true }, SybaseTimeoutError],
    ["the connection died", { connectionDead: true }, SybaseConnectionError]
  ])("closes the native connection at once when %s", async (_name, flags, type) => {
    const conn = await connected();
    expect(opened.size).toBe(1);
    queryFailure.current = { sql: "select 1", error: Object.assign(new Error("boom"), flags) };
    const err = await conn.query("select 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(type);
    // The error says so: the connection cannot be used again.
    expect(err).toMatchObject({ connectionDead: true });
    expect(opened.size).toBe(0);
    expect(conn.isConnected).toBe(false);
  });
});

describe("a native call rejected with no Error", () => {
  // The addon rejects with `undefined` when it cannot even build an Error.
  it.each([undefined, null])("still fails as a driver error (%s)", async value => {
    const conn = await connected();
    queryFailure.current = { sql: "select 1", error: value as never };
    await expect(conn.query("select 1")).rejects.toMatchObject({
      name: "SybaseQueryError",
      message: String(value)
    });

    queryFailure.current = { sql: "@@isolation as iso", error: value as never };
    const opening = new SybaseConnection(config).connect();
    settle();
    await expect(opening).rejects.toBeInstanceOf(SybaseConnectionError);
  });
});
