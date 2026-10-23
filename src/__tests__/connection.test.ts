/**
 * SybaseConnection lifecycle against a stubbed native layer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { opened, pending, server, queries, connectConfigs, connectError } = vi.hoisted(() => ({
  opened: new Set<object>(),
  pending: [] as (() => void)[],
  /** Rows the stubbed server answers to the session-state queries. */
  server: {
    init: [{ iso: 1 }] as Record<string, unknown>[],
    state: [{ tc: 0, ch: 0 }] as Record<string, unknown>[],
    /** When set, the session-init query waits for it. */
    initGate: undefined as Promise<void> | undefined
  },
  queries: [] as string[],
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
    query: async (_handle: object, sql: string) => {
      queries.push(sql);
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
    isAlive: (handle: object) => opened.has(handle)
  }
}));

import { SybaseConnection } from "../connection.js";
import { SybaseConnectionError } from "../errors.js";

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
  connectConfigs.length = 0;
  connectError.message = undefined;
  server.init = [{ iso: 1 }];
  server.state = [{ tc: 0, ch: 0 }];
  server.initGate = undefined;
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
