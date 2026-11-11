/**
 * Bulk copy against a stubbed native layer: how rows become chunks, how batches
 * are committed, and what a failure reports as committed. The real server side
 * is covered by bulk.integration.test.ts.
 */
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeBulkColumn } from "../native/index.js";

/** A chunk as the stub received it, decoded back into rows of field strings (null for NULL). */
interface SentChunk {
  rows: (string | null)[][];
  tsv?: string;
  firstRow: number;
  maxRejects: number;
  commit: 0 | 1 | 2;
  hardTimeoutMs: number;
}

const stub = vi.hoisted(() => ({
  opened: new Set<object>(),
  columns: [] as NativeBulkColumn[],
  begins: [] as Record<string, unknown>[],
  sent: [] as SentChunk[],
  queries: [] as string[],
  /** Replaces the default reply to a bulkSend: return a result, or throw. */
  onSend: undefined as undefined | ((chunk: SentChunk, index: number) => unknown),
  /** Makes bulkBegin reject with this. */
  beginError: undefined as unknown,
  /** Events in order, to check what happened before what. */
  events: [] as string[]
}));

const decode = (chunk: Record<string, any>): Pick<SentChunk, "rows" | "tsv"> => {
  if (chunk.tsv !== undefined) {
    const tsv = typeof chunk.tsv === "string" ? chunk.tsv : Buffer.from(chunk.tsv).toString("utf8");
    const lines = tsv.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return { tsv, rows: lines.map(line => line.split("\t").map(f => (f === "" ? null : f))) };
  }
  const width = stub.columns.length;
  const rows: (string | null)[][] = [];
  let at = 0;
  for (let i = 0; i < chunk.lens.length; i += width) {
    const row: (string | null)[] = [];
    for (let k = 0; k < width; k++) {
      const len = chunk.lens[i + k];
      if (len === 0xffffffff) {
        row.push(null);
      } else {
        row.push(chunk.text.slice(at, at + len));
        at += len;
      }
    }
    rows.push(row);
  }
  return { rows };
};

vi.mock("../native/index.js", () => {
  /** Rows sent since the last commit, per handle. */
  const open = new Map<object, number>();
  return {
    native: {
      connect: async () => {
        const handle = {};
        stub.opened.add(handle);
        return handle;
      },
      query: async (_handle: object, sql: string) => {
        stub.queries.push(sql);
        stub.events.push(`query ${sql.slice(0, 30)}`);
        const rows = sql.includes("@@isolation as iso")
          ? [{ iso: 1 }]
          : sql.includes("@@trancount as tc")
            ? [{ tc: 0, ch: 0 }]
            : [];
        return { rows, columns: [], columnTypes: [], rowCount: rows.length, affectedRows: 0 };
      },
      bulkBegin: async (handle: object, options: Record<string, unknown>) => {
        stub.begins.push(options);
        stub.events.push("begin");
        if (stub.beginError) {
          throw stub.beginError;
        }
        open.set(handle, 0);
        return { columns: stub.columns };
      },
      bulkSend: async (handle: object, raw: Record<string, any>) => {
        const chunk: SentChunk = {
          ...decode(raw),
          firstRow: raw.firstRow,
          maxRejects: raw.maxRejects,
          commit: raw.commit,
          hardTimeoutMs: raw.hardTimeoutMs
        };
        const index = stub.sent.length;
        stub.sent.push(chunk);
        stub.events.push(`send ${raw.rows} commit ${raw.commit}`);
        if (stub.onSend) {
          return stub.onSend(chunk, index);
        }
        const pending = (open.get(handle) ?? 0) + raw.rows;
        open.set(handle, raw.commit ? 0 : pending);
        return {
          rowsSent: raw.rows,
          rejectedCount: 0,
          rejected: [],
          committed: raw.commit ? pending : null,
          discard: false
        };
      },
      close: (handle: object) => {
        stub.events.push("close");
        stub.opened.delete(handle);
      },
      isAlive: (handle: object) => stub.opened.has(handle),
      serverCharset: () => "iso_1"
    }
  };
});

import { SybaseConnection } from "../connection.js";
import { createSybaseDrizzle } from "../db.js";
import {
  SybaseBulkCopyError,
  SybaseConnectionError,
  SybaseQueryError,
  SybaseTimeoutError
} from "../errors.js";

const config = { host: "h", port: 1, database: "d", username: "u", password: "p" };

const column = (
  name: string,
  type: string,
  extra: Partial<NativeBulkColumn> = {}
): NativeBulkColumn => ({
  name,
  type,
  nullable: true,
  length: 10,
  precision: 0,
  scale: 0,
  ...extra
});

const connected = async (extra: Record<string, unknown> = {}) => {
  const conn = new SybaseConnection({ ...config, ...extra });
  await conn.connect();
  return conn;
};

/** A row with the copy's success shape, for the default stub columns. */
const twoColumns = () => {
  stub.columns = [column("k", "int"), column("v", "char")];
};

/** What a native failure of bulkSend carries. */
const nativeError = (message: string, props: Record<string, unknown>) =>
  Object.assign(new Error(message), {
    rowsSent: 0,
    rejectedCount: 0,
    rejected: [],
    committed: null,
    outcome: "none",
    reusable: false,
    connectionDead: true,
    ...props
  });

afterEach(() => {
  stub.opened.clear();
  stub.columns = [];
  stub.begins.length = 0;
  stub.sent.length = 0;
  stub.queries.length = 0;
  stub.events.length = 0;
  stub.onSend = undefined;
  stub.beginError = undefined;
});

describe("bulkInsert: value rows", () => {
  it("sends the rows and commits them in one batch by default", async () => {
    twoColumns();
    const conn = await connected();
    const result = await conn.bulkInsert({
      table: "tempdb..t",
      rows: [
        [1, "a"],
        [2, null],
        [3, undefined]
      ]
    });
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]).toMatchObject({
      rows: [
        ["1", "a"],
        ["2", null],
        ["3", null]
      ],
      firstRow: 1,
      commit: 2,
      maxRejects: 0
    });
    expect(result).toMatchObject({
      rowsCopied: 3,
      batches: [{ rows: 3 }],
      rejected: [],
      rejectedCount: 0
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(conn.isConnected).toBe(true);
  });

  it("passes the table, columns and options to the native layer", async () => {
    twoColumns();
    const conn = await connected();
    await conn.bulkInsert({
      table: "apradb.dbo.DDSD",
      columns: ["k", "v"],
      rows: [[1, "a"]],
      keepIdentity: true,
      ignoreDefaults: true,
      allowConstraintBypass: true,
      timeoutSeconds: 7
    });
    expect(stub.begins[0]).toMatchObject({
      table: "apradb.dbo.DDSD",
      columns: ["k", "v"],
      keepIdentity: true,
      ignoreDefaults: true,
      allowConstraintBypass: true,
      timeoutSeconds: 7
    });
    // Derived from timeoutSeconds, as for a query: 2x, at least 30 s.
    expect(stub.begins[0]!.hardTimeoutMs).toBeLessThanOrEqual(30_000);
    expect(stub.begins[0]!.hardTimeoutMs).toBeGreaterThan(29_000);
  });

  it("encodes each column type exactly", async () => {
    stub.columns = [
      column("i", "int"),
      column("b", "bigint"),
      column("m", "money"),
      column("n4", "numeric", { precision: 19, scale: 4 }),
      column("n2", "numeric", { precision: 7, scale: 2 }),
      column("f", "float"),
      column("bit", "bit"),
      column("d", "datetime"),
      column("s", "char"),
      column("bin", "varbinary")
    ];
    const conn = await connected({ timeZone: "Australia/Sydney" });
    await conn.bulkInsert({
      table: "t",
      rows: [
        [
          -5,
          9007199254740993n,
          "12.3456",
          10n,
          1.25,
          0.1,
          true,
          new Date("2024-01-01T00:00:00.007Z"),
          "é",
          Buffer.from([0, 255, 16])
        ],
        [
          "7",
          "-1",
          "3",
          "-0.0001",
          "2",
          "1e10",
          0,
          "2024-02-29 23:59:59.999",
          "",
          new Uint8Array([1])
        ]
      ]
    });
    expect(stub.sent[0]!.rows).toEqual([
      [
        "-5",
        "9007199254740993",
        "12.3456",
        "10",
        "1.25",
        "0.1",
        "1",
        // The wall clock in the connection's zone, as the query builders write it.
        "2024-01-01 11:00:00.007",
        "é",
        "00ff10"
      ],
      ["7", "-1", "3", "-0.0001", "2", "1e10", "0", "2024-02-29 23:59:59.999", "", "01"]
    ]);
  });

  // String(1e-7) is "1e-7", which the native decimal parser does not take.
  it("writes a number for a narrow numeric without an exponent", async () => {
    stub.columns = [column("n", "numeric", { precision: 15, scale: 8 })];
    const conn = await connected();
    await conn.bulkInsert({ table: "t", rows: [[1e-7], [-1.5e-7], [1.25e-5], [123.5]] });
    expect(stub.sent[0]!.rows).toEqual([["0.0000001"], ["-0.00000015"], ["0.0000125"], ["123.5"]]);
    stub.columns = [column("n", "numeric", { precision: 15, scale: 0 })];
    stub.sent.length = 0;
    await conn.bulkInsert({ table: "t", rows: [[1e21], [-2.5e22]] });
    expect(stub.sent[0]!.rows).toEqual([["1000000000000000000000"], ["-25000000000000000000000"]]);
  });

  // A commit whose answer could not be read (N-API failed building it) is not
  // a commit of nothing: the rows are reported in doubt.
  it("reports a batch in doubt when the commit's answer carries no count", async () => {
    twoColumns();
    stub.onSend = () => ({ rowsSent: 1, rejectedCount: 0, rejected: [], discard: false });
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: [[1, "a"]] })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toMatchObject({ rowsCommitted: 0, rowsInDoubt: 1 });
    stub.onSend = () => {
      throw new Error("Could not hand the bulk copy's answer to JavaScript");
    };
    const err2 = (await (
      await connected()
    )
      .bulkInsert({ table: "t", rows: [[1, "a"]] })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err2).toMatchObject({ rowsCommitted: 0, rowsInDoubt: 1 });
  });

  it.each([
    ["a number into money", "money", 1.5, /money column takes a decimal string/],
    // Whole units or ten-thousandths? Either guess stores some amounts 10,000 times off.
    ["a bigint into money", "money", 123456n, /a bigint is refused, as its unit would be a guess/],
    ["a bigint into smallmoney", "smallmoney", 1n, /a bigint is refused/],
    ["an unsafe integer", "bigint", 2 ** 53 + 2, /safe-integer number/],
    ["a fraction into int", "int", 1.5, /safe-integer number/],
    ["a number into a wide numeric", "numeric", 1.5, /not a number/],
    ["a number into char", "char", 5, /takes a string/],
    ["a string into binary", "varbinary", "00ff", /Uint8Array/],
    ["2 into bit", "bit", 2, /boolean, 0 or 1/],
    ["an invalid Date", "datetime", new Date(Number.NaN), /./],
    ["an object", "int", {}, /is a object/]
  ])("refuses %s, naming the row and column", async (_name, type, value, message) => {
    stub.columns = [column("k", "int"), column("x", type, { precision: 19, scale: 4 })];
    const conn = await connected();
    const err = await conn
      .bulkInsert({
        table: "t",
        rows: [
          [1, null],
          [2, value as never]
        ]
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    const bulkErr = err as SybaseBulkCopyError;
    expect(bulkErr.row).toBe(2);
    expect(bulkErr.column).toBe("x");
    expect(bulkErr.message).toMatch(message);
    expect(bulkErr.message).toMatch(/No rows were committed/);
    expect(bulkErr.rowsCommitted).toBe(0);
    expect(bulkErr.cause).toBeInstanceOf(TypeError);
    // The copy was abandoned: the connection is closed, so nothing it began commits.
    expect(conn.isConnected).toBe(false);
    expect(stub.sent.filter(c => c.commit !== 0)).toEqual([]);
  });

  // Refused before it is sent: a huge value for a narrow column must not be
  // copied across to the native side, and sized there, first.
  it("refuses a value longer than its column before sending it", async () => {
    stub.columns = [column("v", "char", { length: 10 }), column("b", "varbinary", { length: 4 })];
    const huge = "a".repeat(10 * 1024 * 1024);
    for (const [row, message] of [
      [[huge, null], /value is at least 10485760 bytes .*the column holds 10/],
      [[null, new Uint8Array(5)], /value is 5 bytes; the column holds 4/],
      [[null, new Uint8Array(0)], /value is empty: ASE has no zero-length binary value/]
    ] as const) {
      const err = (await (
        await connected()
      )
        .bulkInsert({ table: "t", rows: [row as never] })
        .catch((e: unknown) => e)) as SybaseBulkCopyError;
      expect(err.message).toMatch(message);
    }
    expect(stub.sent).toEqual([]);
    // Trailing blanks are not data: they do not count against the column.
    await (await connected()).bulkInsert({ table: "t", rows: [["abc" + " ".repeat(50), null]] });
    expect(stub.sent[0]!.rows).toEqual([["abc       ", null]]);
  });

  it("lets the caller's source clean up when the copy fails", async () => {
    stub.columns = [column("k", "int"), column("m", "money")];
    let closed = false;
    function* rows() {
      try {
        yield [1, "1"];
        yield [2, 2.5]; // refused: a number into money
        yield [3, "3"];
      } finally {
        closed = true;
      }
    }
    const conn = await connected();
    await expect(conn.bulkInsert({ table: "t", rows: rows() })).rejects.toBeInstanceOf(
      SybaseBulkCopyError
    );
    expect(closed).toBe(true);
  });

  it("refuses a row of the wrong width", async () => {
    twoColumns();
    const conn = await connected();
    await expect(conn.bulkInsert({ table: "t", rows: [[1, "a", "extra"]] })).rejects.toThrow(
      /row 1: has 3 values; 2 columns are copied/
    );
  });

  it("leaves rejected rows out under maxErrors, keeping row numbers right", async () => {
    stub.columns = [column("k", "int"), column("m", "money")];
    const conn = await connected();
    const result = await conn.bulkInsert({
      table: "t",
      rows: [
        [1, "1"],
        [2, 2.5],
        [3, "3"],
        [4, "4"]
      ],
      maxErrors: 1
    });
    // The chunk ends at the gap the rejected row leaves, so that each chunk's
    // rows are numbered consecutively from its firstRow.
    expect(stub.sent.map(c => [c.firstRow, c.rows.length, c.commit])).toEqual([
      [1, 1, 0],
      [3, 2, 2]
    ]);
    // One rejection is used up: the native side may reject no more.
    expect(stub.sent[1]!.maxRejects).toBe(0);
    expect(result.rowsCopied).toBe(3);
    expect(result.rejectedCount).toBe(1);
    expect(result.rejected).toEqual([
      { row: 2, column: "m", message: expect.stringMatching(/money column takes/) }
    ]);
  });

  // A number, date or bit is never that long: refused before it is copied into
  // a chunk, so that no value can make one far larger than its budget.
  it("refuses an over-long value of a type that is not text, before sending it", async () => {
    stub.columns = [column("k", "int"), column("m", "money")];
    const conn = await connected();
    const result = await conn.bulkInsert({
      table: "t",
      rows: [
        ["1".repeat(8 * 1024 * 1024), "1"],
        [2, "2"]
      ],
      maxErrors: 1
    });
    expect(result.rowsCopied).toBe(1);
    expect(result.rejected).toEqual([
      { row: 1, column: "k", message: expect.stringMatching(/8388608 characters long/) }
    ]);
    expect(stub.sent.map(c => c.rows)).toEqual([[["2", "2"]]]);
  });

  it("counts rows the native side rejects", async () => {
    twoColumns();
    stub.onSend = chunk => ({
      rowsSent: chunk.rows.length - 1,
      rejectedCount: 1,
      rejected: [{ row: 2, column: "v", message: "value is 12 bytes; the column holds 10" }],
      committed: chunk.commit ? chunk.rows.length - 1 : null,
      discard: false
    });
    const conn = await connected();
    const result = await conn.bulkInsert({
      table: "t",
      rows: [
        [1, "a"],
        [2, "éééééé"], // 6 characters, 12 bytes in UTF-8: only the native side can tell
        [3, "c"]
      ],
      maxErrors: 5
    });
    expect(stub.sent[0]!.maxRejects).toBe(5);
    expect(result).toMatchObject({ rowsCopied: 2, rejectedCount: 1 });
    expect(result.rejected[0]).toMatchObject({ row: 2, column: "v" });
  });

  it("reads a generator lazily, one chunk ahead of what is being sent", async () => {
    twoColumns();
    let produced = 0;
    function* rows() {
      for (let i = 0; i < 25_000; i++) {
        produced++;
        yield [i, "x"];
      }
    }
    let producedAtFirstSend = 0;
    stub.onSend = (chunk, index) => {
      if (index === 0) {
        producedAtFirstSend = produced;
      }
      return {
        rowsSent: chunk.rows.length,
        rejectedCount: 0,
        rejected: [],
        committed: chunk.commit ? 25_000 : null,
        discard: false
      };
    };
    const conn = await connected();
    await conn.bulkInsert({ table: "t", rows: rows() });
    expect(stub.sent.map(c => c.rows.length)).toEqual([10_000, 10_000, 5_000]);
    // The chunk after the first had been read when the first was sent (to know
    // it was not the last), and the read after that had begun — not all 25,000.
    expect(producedAtFirstSend).toBeGreaterThanOrEqual(20_000);
    expect(producedAtFirstSend).toBeLessThan(25_000);
  });
});

describe("bulkInsert: batches", () => {
  it("commits every batchSize rows and reports each batch the server confirmed", async () => {
    twoColumns();
    const conn = await connected();
    const rows = Array.from({ length: 7 }, (_, i) => [i, "x"]);
    const result = await conn.bulkInsert({ table: "t", rows, batchSize: 3 });
    expect(stub.sent.map(c => [c.rows.length, c.commit])).toEqual([
      [3, 1],
      [3, 1],
      [1, 2]
    ]);
    expect(result.rowsCopied).toBe(7);
    expect(result.batches).toEqual([{ rows: 3 }, { rows: 3 }, { rows: 1 }]);
  });

  // An async source cannot say it has ended without being read again, which
  // could hold the batch back: it is committed, and the copy ended after.
  it("ends the copy with an empty call when an async source stops on a batch boundary", async () => {
    twoColumns();
    const conn = await connected();
    async function* rows() {
      for (let i = 0; i < 6; i++) {
        yield [i, "x"];
      }
    }
    const result = await conn.bulkInsert({ table: "t", rows: rows(), batchSize: 3 });
    expect(stub.sent.map(c => [c.rows.length, c.commit, c.firstRow])).toEqual([
      [3, 1, 1],
      [3, 1, 4],
      [0, 2, 7]
    ]);
    // The empty end commits nothing and is no batch.
    expect(result.batches).toEqual([{ rows: 3 }, { rows: 3 }]);
  });

  // Known to be the last — TSV given whole — the batch is committed with the
  // copy's end: one round trip fewer than an empty closing call.
  it.each([
    ["a TSV string", Array.from({ length: 6 }, (_, i) => `${i}\tx\n`).join("")],
    ["a TSV Buffer", Buffer.from(Array.from({ length: 6 }, (_, i) => `${i}\tx\n`).join(""))]
  ])(
    "commits the last batch with the copy's end when %s stops on a batch boundary",
    async (_n, rows) => {
      twoColumns();
      const conn = await connected();
      const result = await conn.bulkInsert({ table: "t", rows: rows as never, batchSize: 3 });
      expect(stub.sent.map(c => [c.rows.length, c.commit, c.firstRow])).toEqual([
        [3, 1, 1],
        [3, 2, 4]
      ]);
      expect(result.rowsCopied).toBe(6);
    }
  );

  // The batch a source gave in full before failing is committed.
  it("still commits a full batch when the source fails right after it", async () => {
    twoColumns();
    function* rows() {
      for (let i = 0; i < 3; i++) {
        yield [i, "x"];
      }
      throw new Error("source broke");
    }
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: rows(), batchSize: 3 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/source broke/);
    expect(err.rowsCommitted).toBe(3);
  });

  // Whatever a source throws — even a value with no string form — the copy
  // fails as itself, saying what it committed.
  it("fails as a bulk copy error when the source throws a value with no string form", async () => {
    twoColumns();
    const thrown = Object.create(null) as object;
    function* rows() {
      for (let i = 0; i < 3; i++) {
        yield [i, "x"];
      }
      throw thrown;
    }
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: rows(), batchSize: 3 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.message).toMatch(/reading the rows failed: \[object Object\]/);
    expect(err.cause).toBe(thrown);
    expect(err.rowsCommitted).toBe(3);
  });

  // A full batch is not held back waiting to learn whether more rows follow.
  it("commits a full batch before the next row has been read", async () => {
    twoColumns();
    let release!: () => void;
    async function* rows() {
      yield [1, "a"];
      yield [2, "b"];
      await new Promise<void>(resolve => (release = resolve));
      yield [3, "c"];
    }
    const conn = await connected();
    const copying = conn.bulkInsert({ table: "t", rows: rows(), batchSize: 2 });
    await vi.waitFor(() => expect(stub.sent.map(c => c.commit)).toEqual([1]));
    release();
    const result = await copying;
    expect(stub.sent.map(c => [c.rows.length, c.commit])).toEqual([
      [2, 1],
      [1, 2]
    ]);
    expect(result.rowsCopied).toBe(3);
  });

  it("ends a copy of no rows, committing nothing", async () => {
    twoColumns();
    const conn = await connected();
    const result = await conn.bulkInsert({ table: "t", rows: [], expectedRows: 0 });
    expect(stub.sent.map(c => [c.rows.length, c.commit])).toEqual([[0, 2]]);
    expect(result).toMatchObject({ rowsCopied: 0, batches: [] });
    expect(conn.isConnected).toBe(true);
  });

  it("fails before the commit when the input has more rows than expectedRows", async () => {
    twoColumns();
    const conn = await connected();
    const err = (await conn
      .bulkInsert({
        table: "t",
        rows: [
          [1, "a"],
          [2, "b"],
          [3, "c"]
        ],
        batchSize: 2,
        expectedRows: 2
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.message).toMatch(/expectedRows is 2, but the input has more rows/);
    // The first batch (2 rows) is within the expectation and committed; the
    // extra row never reached a commit.
    expect(err.rowsCommitted).toBe(2);
    expect(stub.sent.map(c => c.commit)).toEqual([1]);
    expect(conn.isConnected).toBe(false);
  });

  // With maxErrors the rows copied are known only once sent: past expectedRows
  // the copy stops then, not after reading and sending the rest.
  it("stops sending as soon as more rows than expectedRows are copied, with maxErrors", async () => {
    stub.columns = [column("k", "int")];
    const rows = Array.from({ length: 30_000 }, (_, i) => [i]);
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows, expectedRows: 1, maxErrors: 1, batchSize: "all" })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/expectedRows is 1, but the input has more rows/);
    expect(stub.sent).toHaveLength(1);
    expect(err.rowsCommitted).toBe(0);
  });

  // The error says how the connection is, not only how this failure left it.
  it("reports the connection dead when an earlier commit discarded it", async () => {
    stub.columns = [column("k", "int")];
    stub.onSend = () =>
      Promise.resolve({ rowsSent: 0, rejectedCount: 0, rejected: [], committed: 0, discard: true });
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: [], expectedRows: 1 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/expectedRows is 1, but the input has no rows/);
    expect(conn.isConnected).toBe(false);
    expect(err.connectionDead).toBe(true);
  });

  it("fails before the commit when the input has fewer rows than expectedRows", async () => {
    twoColumns();
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: [[1, "a"]], expectedRows: 2 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/expectedRows is 2, but 1 rows would be copied/);
    expect(err.rowsCommitted).toBe(0);
    expect(stub.sent).toHaveLength(0);
    expect(conn.isConnected).toBe(false);
  });

  // A full last batch must not commit before the count is known to be right.
  it("checks expectedRows before committing a full batch that turns out to be the last", async () => {
    twoColumns();
    const conn = await connected();
    const err = (await conn
      .bulkInsert({
        table: "t",
        rows: [
          [1, "a"],
          [2, "b"]
        ],
        batchSize: 2,
        expectedRows: 3
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.message).toMatch(/expectedRows is 3, but 2 rows would be copied/);
    expect(err.rowsCommitted).toBe(0);
    expect(stub.sent).toEqual([]);
  });

  it("commits a full last batch once, without an empty end, when expectedRows matches", async () => {
    twoColumns();
    const conn = await connected();
    const result = await conn.bulkInsert({
      table: "t",
      rows: [
        [1, "a"],
        [2, "b"],
        [3, "c"],
        [4, "d"]
      ],
      batchSize: 2,
      expectedRows: 4
    });
    expect(stub.sent.map(c => [c.rows.length, c.commit])).toEqual([
      [2, 1],
      [2, 2]
    ]);
    expect(result.rowsCopied).toBe(4);
  });

  // The next chunk is read while the native side is still sending this one:
  // rows refused on both sides together must not pass maxErrors.
  it("fails once rows refused by the reader and by the native side pass maxErrors", async () => {
    stub.columns = [column("k", "int")];
    stub.onSend = async chunk => {
      await new Promise(resolve => setTimeout(resolve, 20));
      const rejected = chunk.rows
        .map((row, i) => ({ row: chunk.firstRow + i, value: row[0] }))
        .filter(r => r.value === "bad")
        .map(r => ({ row: r.row, column: "k", message: "is not an integer" }));
      if (rejected.length > chunk.maxRejects) {
        throw nativeError("too many", { rejected, rejectedCount: rejected.length });
      }
      const sent = chunk.rows.length - rejected.length;
      return {
        rowsSent: sent,
        rejectedCount: rejected.length,
        rejected,
        committed: chunk.commit ? sent : null,
        discard: false
      };
    };
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: [["bad"], [1], [1.5], [2]], batchSize: 2, maxErrors: 1 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err).toMatchObject({ row: 3, column: "k", rowsCommitted: 1 });
    // The batch holding the row past the limit was never sent.
    expect(stub.sent).toHaveLength(1);
    expect(err.rejected.map(r => r.row)).toEqual([1, 3]);
  });

  // A read that fails part way still reports the rows it refused before.
  it("lists rows refused before the read that failed", async () => {
    stub.columns = [column("k", "int")];
    let err = (await (
      await connected()
    )
      .bulkInsert({ table: "t", rows: [[1.5], [2.5]], maxErrors: 1 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toMatchObject({ row: 2, column: "k" });
    expect(err.rejected.map(r => r.row)).toEqual([1, 2]);
    function* failing() {
      yield [1.5];
      throw new Error("source failed");
    }
    err = (await (
      await connected()
    )
      .bulkInsert({ table: "t", rows: failing(), maxErrors: 1 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/source failed/);
    expect(err.rejected.map(r => r.row)).toEqual([1]);
    expect(stub.sent).toEqual([]);
  });

  it("keeps a refused row that follows good ones when a later read fails", async () => {
    stub.columns = [column("k", "int")];
    function* failing() {
      yield [1];
      yield [1.5];
      throw new Error("source failed");
    }
    const err = (await (
      await connected()
    )
      .bulkInsert({ table: "t", rows: failing(), maxErrors: 5 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/source failed/);
    expect(err.rejected.map(r => r.row)).toEqual([2]);
  });

  // The row past the limit is known as soon as it is read: the copy fails then,
  // without waiting on the rest of the source.
  it("fails on a row past maxErrors without waiting for the source to go on", async () => {
    stub.columns = [column("k", "int")];
    async function* stalls() {
      yield [1];
      yield [1.5];
      await new Promise(() => {});
    }
    const err = (await (
      await connected()
    )
      .bulkInsert({ table: "t", rows: stalls(), maxErrors: 0 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toMatchObject({ row: 2, column: "k", rowsCommitted: 0 });
    expect(stub.sent).toEqual([]);
  });

  it("checks expectedRows before a separate commit when rows may be rejected", async () => {
    twoColumns();
    stub.onSend = chunk => ({
      rowsSent: chunk.rows.length === 0 ? 0 : chunk.rows.length - 1,
      rejectedCount: chunk.rows.length === 0 ? 0 : 1,
      rejected: [],
      committed: chunk.commit ? 1 : null,
      discard: false
    });
    const conn = await connected();
    const err = (await conn
      .bulkInsert({
        table: "t",
        rows: [
          [1, "a"],
          [2, "b"]
        ],
        maxErrors: 1,
        expectedRows: 2
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    // The rows went in a call that did not commit; the count was then short.
    expect(stub.sent.map(c => c.commit)).toEqual([0]);
    expect(err.message).toMatch(/expectedRows is 2, but 1 rows would be copied/);
    expect(err.rowsCommitted).toBe(0);
  });

  it("commits in a call of its own once the count matches", async () => {
    twoColumns();
    const conn = await connected();
    const result = await conn.bulkInsert({
      table: "t",
      rows: [
        [1, "a"],
        [2, "b"]
      ],
      maxErrors: 1,
      expectedRows: 2
    });
    expect(stub.sent.map(c => [c.rows.length, c.commit])).toEqual([
      [2, 0],
      [0, 2]
    ]);
    expect(result.rowsCopied).toBe(2);
  });

  it("fails when the server confirms another count than was sent", async () => {
    twoColumns();
    stub.onSend = chunk => ({
      rowsSent: chunk.rows.length,
      rejectedCount: 0,
      rejected: [],
      committed: chunk.commit ? chunk.rows.length - 1 : null,
      discard: false
    });
    const conn = await connected();
    const err = (await conn
      .bulkInsert({
        table: "t",
        rows: [
          [1, "a"],
          [2, "b"]
        ]
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.message).toMatch(/the server reported 1 rows committed for a batch of 2 rows sent/);
    // What the server says is committed is what is reported.
    expect(err.rowsCommitted).toBe(1);
    expect(err.batches).toEqual([{ rows: 1 }]);
  });
});

describe("bulkInsert: TSV", () => {
  it("sends a TSV string as it is, row by row", async () => {
    twoColumns();
    const conn = await connected();
    const tsv = "1\ta\r\n2\t\n3\tc";
    const result = await conn.bulkInsert({ table: "t", rows: tsv });
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]!.tsv).toBe(tsv);
    expect(stub.sent[0]!.commit).toBe(2);
    expect(result.rowsCopied).toBe(3);
  });

  it("splits TSV at batch boundaries and keeps row numbers", async () => {
    twoColumns();
    const conn = await connected();
    await conn.bulkInsert({ table: "t", rows: Buffer.from("1\ta\n2\tb\n3\tc\n"), batchSize: 2 });
    expect(stub.sent.map(c => [c.tsv, c.firstRow, c.commit])).toEqual([
      ["1\ta\n2\tb\n", 1, 1],
      ["3\tc\n", 3, 2]
    ]);
  });

  it("joins a stream of pieces split anywhere, even inside a character", async () => {
    twoColumns();
    const conn = await connected();
    const text = Array.from({ length: 500 }, (_, i) => `${i}\tvalé ${i}\n`).join("");
    const bytes = Buffer.from(text);
    const pieces: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      pieces.push(bytes.subarray(i, i + 7));
    }
    const result = await conn.bulkInsert({
      table: "t",
      rows: Readable.from(pieces),
      batchSize: 120
    });
    expect(stub.sent.map(c => c.tsv).join("")).toBe(text);
    expect(stub.sent.map(c => c.rows.length)).toEqual([120, 120, 120, 120, 20]);
    expect(stub.sent.map(c => c.firstRow)).toEqual([1, 121, 241, 361, 481]);
    expect(result.rowsCopied).toBe(500);
  });

  it("does not wait to fill a chunk when the source ends", async () => {
    twoColumns();
    const conn = await connected();
    await conn.bulkInsert({ table: "t", rows: ["1\ta\n2", "\tb"] });
    expect(stub.sent.map(c => c.tsv)).toEqual(["1\ta\n2\tb"]);
  });

  // A stream with no newline would otherwise be buffered without end.
  it("refuses a streamed TSV row longer than 4 MiB instead of buffering on", async () => {
    twoColumns();
    function* noNewline() {
      for (;;) {
        yield Buffer.alloc(1024 * 1024, 0x41);
      }
    }
    const conn = await connected();
    await expect(conn.bulkInsert({ table: "t", rows: noNewline() })).rejects.toThrow(
      /row 1 of the TSV is longer than 4194304 bytes with no newline/
    );
    expect(conn.isConnected).toBe(false);
  });

  it("refuses a TSV row longer than 4 MiB however it is given", async () => {
    twoColumns();
    const long = "1\t" + "a".repeat(4 * 1024 * 1024) + "\n";
    for (const rows of [long, Buffer.from(long), [long], ["1\tb\n" + long]]) {
      const conn = await connected();
      await expect(conn.bulkInsert({ table: "t", rows })).rejects.toThrow(
        /row \d of the TSV is longer than 4194304 bytes/
      );
    }
    expect(stub.sent).toEqual([]);
  });

  // A file stream hands over fresh buffers, but a source may reuse one.
  it("joins a character split between two string pieces", async () => {
    twoColumns();
    for (const rows of [
      ["1\t\uD83D", "\uDE00\n"],
      ["1\t\uD83D", Buffer.alloc(0), "\uDE00\n"]
    ]) {
      stub.sent.length = 0;
      await (await connected()).bulkInsert({ table: "t", rows });
      expect(stub.sent.map(c => c.tsv)).toEqual(["1\t😀\n"]);
    }
    await expect(
      (await connected()).bulkInsert({ table: "t", rows: ["1\ta\uD83D"] })
    ).rejects.toThrow(/unpaired surrogate/);
  });

  it("refuses a lone surrogate anywhere in TSV text instead of storing U+FFFD", async () => {
    twoColumns();
    for (const rows of ["1\ta\uD800b\n", ["1\t\uDC00\n"], ["1\ta\uD800", "b\n"]]) {
      await expect((await connected()).bulkInsert({ table: "t", rows })).rejects.toThrow(
        /unpaired surrogate/
      );
    }
    expect(stub.sent).toEqual([]);
  });

  it("copies a TSV stream of tiny pieces exactly", async () => {
    twoColumns();
    const text = Array.from({ length: 30_000 }, (_, i) => `${i}\tv${i}\n`).join("");
    const bytes = Buffer.from(text);
    function* oneByteAtATime() {
      const reused = Buffer.alloc(1);
      for (const byte of bytes) {
        reused[0] = byte;
        yield reused;
      }
    }
    const conn = await connected();
    const result = await conn.bulkInsert({ table: "t", rows: oneByteAtATime() });
    expect(stub.sent.map(c => c.tsv).join("")).toBe(text);
    expect(result.rowsCopied).toBe(30_000);
  });

  it("refuses a source that mixes TSV pieces and value rows", async () => {
    twoColumns();
    const conn = await connected();
    await expect(
      conn.bulkInsert({ table: "t", rows: ["1\ta\n", [2, "b"]] as never })
    ).rejects.toThrow(/reading the rows failed: .*expected strings or Buffers/);
    expect(conn.isConnected).toBe(false);
  });
});

describe("bulkInsert: reading and the deadline", () => {
  // The deadline's timer cannot fire while a synchronous source runs: the
  // clock is read again before anything is sent.
  it("sends nothing once a synchronous source has run past the deadline", async () => {
    twoColumns();
    function* slow() {
      const until = performance.now() + 60;
      while (performance.now() < until) {
        // busy, as a source computing its rows would be
      }
      yield [1, "a"];
    }
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: slow(), hardTimeoutMs: 20 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.cause).toBeInstanceOf(SybaseTimeoutError);
    expect(err).toMatchObject({ rowsCommitted: 0, rowsInDoubt: 0 });
    expect(stub.sent).toEqual([]);
  });

  // A batch given in full is committed without waiting for more input.
  it("sends a full TSV batch while the source pauses", async () => {
    twoColumns();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    async function* paused() {
      yield "1\ta\n2\tb\n";
      await gate;
      yield "3\tc\n";
    }
    const conn = await connected();
    const copy = conn.bulkInsert({ table: "t", rows: paused(), batchSize: 2 });
    await vi.waitFor(() => expect(stub.sent).toHaveLength(1));
    expect(stub.sent[0]).toMatchObject({ commit: 1, tsv: "1\ta\n2\tb\n" });
    release();
    expect((await copy).rowsCopied).toBe(3);
  });

  // Chunks are bounded by the bytes sent, which for a string is its UTF-8.
  it("cuts a TSV string into chunks by its UTF-8 size", async () => {
    stub.columns = [column("v", "char", { length: 1500 })];
    const row = "汉".repeat(500) + "\n"; // 1501 bytes in UTF-8, 501 UTF-16 units
    const conn = await connected();
    await conn.bulkInsert({ table: "t", rows: row.repeat(9000) });
    const sizes = stub.sent.map(c => Buffer.byteLength(c.tsv ?? ""));
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(stub.sent.reduce((n, c) => n + c.rows.length, 0)).toBe(9000);
  });

  // As `for await` does: a null or undefined Symbol.asyncIterator falls back
  // to Symbol.iterator.
  it("reads an iterable whose Symbol.asyncIterator is undefined synchronously", async () => {
    stub.columns = [column("k", "int")];
    const rows = {
      [Symbol.asyncIterator]: undefined,
      *[Symbol.iterator]() {
        yield [1];
        yield [2];
      }
    };
    const conn = await connected();
    expect((await conn.bulkInsert({ table: "t", rows })).rowsCopied).toBe(2);
  });

  it("refuses rows whose Symbol.asyncIterator is not a function before opening the copy", async () => {
    stub.columns = [column("k", "int")];
    const rows = { [Symbol.asyncIterator]: 1, *[Symbol.iterator]() {} };
    const conn = await connected();
    await expect(conn.bulkInsert({ table: "t", rows: rows as never })).rejects.toThrow(TypeError);
    expect(stub.events).not.toContain("begin");
  });

  // Mixing is a source's mistake, not a bad row maxErrors may skip.
  it("stops a source of value rows that yields TSV, whatever maxErrors", async () => {
    stub.columns = [column("k", "int")];
    const conn = await connected();
    const err = await conn
      .bulkInsert({ table: "t", rows: [[1], "2\n"] as never, maxErrors: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect((err as Error).message).toMatch(/rows cannot mix TSV and arrays/);
    expect((err as SybaseBulkCopyError).rowsCommitted).toBe(0);
  });

  it("reports a source that fails to start as a bulk copy failure", async () => {
    twoColumns();
    const rows = {
      [Symbol.iterator](): Iterator<never> {
        throw new Error("iterator factory failed");
      }
    };
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.message).toMatch(/reading the rows failed: iterator factory failed/);
    expect(err.rowsCommitted).toBe(0);
    expect(conn.isConnected).toBe(false);
  });

  // The empty end of a copy whose last batch was full starts after every input
  // row read — refused ones included.
  it("numbers the closing empty batch after every row read", async () => {
    stub.columns = [column("k", "int")];
    const conn = await connected();
    async function* rows() {
      yield [1.5];
      yield [2];
    }
    await conn.bulkInsert({ table: "t", rows: rows(), batchSize: 2, maxErrors: 2 });
    expect(stub.sent.map(c => [c.rows.length, c.firstRow, c.commit])).toEqual([
      [1, 2, 1],
      [0, 3, 2]
    ]);
  });

  // Field lengths are part of a chunk's size: a wide row of NULLs is all lengths.
  it("bounds a chunk of wide NULL rows by its lengths too", async () => {
    stub.columns = Array.from({ length: 256 }, (_, i) => column(`c${i}`, "int"));
    const rows = Array.from({ length: 10_000 }, () => Array.from({ length: 256 }, () => null));
    const conn = await connected();
    await conn.bulkInsert({ table: "t", rows });
    expect(stub.sent.length).toBeGreaterThan(1);
    expect(stub.sent.reduce((n, c) => n + c.rows.length, 0)).toBe(10_000);
  });

  it("gives the full count of rows refused before a failure, past the 1000 listed", async () => {
    stub.columns = [column("k", "int")];
    const rows = [...Array.from({ length: 1500 }, () => [1.5]), [1]];
    stub.onSend = () => {
      throw nativeError("broken", { outcome: "none" });
    };
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows, maxErrors: 2000 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.rejected).toHaveLength(1000);
    expect(err.rejectedCount).toBe(1500);
  });
});

describe("bulkInsert: failures", () => {
  it("reports exactly the batches committed before a batch the server refused", async () => {
    twoColumns();
    stub.onSend = (chunk, index) => {
      if (index === 1) {
        throw nativeError("Msg 2601, Level 14, State 2: Attempt to insert duplicate key row", {
          rowsSent: 2,
          outcome: "failed"
        });
      }
      return { rowsSent: 2, rejectedCount: 0, rejected: [], committed: 2, discard: false };
    };
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: Array.from({ length: 6 }, (_, i) => [i, "x"]), batchSize: 2 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.message).toMatch(
      /duplicate key row\. 2 rows were committed by 1 earlier batch; nothing else was\.$/
    );
    expect(err.rowsCommitted).toBe(2);
    expect(err.rowsInDoubt).toBe(0);
    expect(err.batches).toEqual([{ rows: 2 }]);
    expect(err.cause).toBeInstanceOf(SybaseQueryError);
    expect(err.msgNo).toBe(2601);
    expect(err.connectionDead).toBe(true);
    expect(conn.isConnected).toBe(false);
  });

  it("reports the rows whose commit was cut off as in doubt", async () => {
    twoColumns();
    stub.onSend = (chunk, index) => {
      if (index === 0) {
        return { rowsSent: 2, rejectedCount: 0, rejected: [], committed: null, discard: false };
      }
      throw nativeError("DB-Lib error 20006: Write to the server failed", {
        rowsSent: 1,
        outcome: "unknown",
        connectionLost: true
      });
    };
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", rows: Array.from({ length: 12_000 }, (_, i) => [i, "x"]) })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.rowsCommitted).toBe(0);
    expect(err.rowsInDoubt).toBe(3);
    expect(err.message).toMatch(/the commit of the last batch \(3 rows\) was under way/);
    expect(err.cause).toBeInstanceOf(SybaseConnectionError);
  });

  it("counts what a failed call committed before it failed", async () => {
    twoColumns();
    stub.onSend = () => {
      throw nativeError("Bulk copy exceeded hard timeout", {
        rowsSent: 2,
        committed: 2,
        hardTimeout: true
      });
    };
    const conn = await connected();
    const err = (await conn
      .bulkInsert({
        table: "t",
        rows: [
          [1, "a"],
          [2, "b"]
        ]
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.rowsCommitted).toBe(2);
    expect(err.rowsInDoubt).toBe(0);
    expect(err.cause).toBeInstanceOf(SybaseTimeoutError);
  });

  it("keeps the connection when the copy failed before it started", async () => {
    twoColumns();
    stub.beginError = Object.assign(new Error("Table t has no column 'nope'"), { reusable: true });
    const conn = await connected();
    const err = (await conn
      .bulkInsert({ table: "t", columns: ["nope"], rows: [] })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.message).toMatch(/has no column 'nope'/);
    expect(err.connectionDead).toBe(false);
    expect(conn.isConnected).toBe(true);
  });

  it("closes the connection when opening the copy left it unusable", async () => {
    twoColumns();
    stub.beginError = Object.assign(new Error("bcp_init() failed"), { reusable: false });
    const conn = await connected();
    await expect(conn.bulkInsert({ table: "t", rows: [] })).rejects.toThrow(/bcp_init/);
    expect(conn.isConnected).toBe(false);
  });

  it("closes the connection when the session could not be restored after a copy", async () => {
    twoColumns();
    stub.onSend = () => ({
      rowsSent: 1,
      rejectedCount: 0,
      rejected: [],
      committed: 1,
      discard: true
    });
    const conn = await connected();
    const result = await conn.bulkInsert({ table: "t", rows: [[1, "a"]] });
    expect(result.rowsCopied).toBe(1);
    expect(conn.isConnected).toBe(false);
  });

  it("does not close the connection under a send still in flight when reading fails", async () => {
    twoColumns();
    let release!: () => void;
    stub.onSend = chunk =>
      new Promise(resolve => {
        release = () =>
          resolve({
            rowsSent: chunk.rows.length,
            rejectedCount: 0,
            rejected: [],
            committed: null,
            discard: false
          });
      });
    function* rows() {
      for (let i = 0; i < 20_001; i++) {
        yield [i, "x"];
      }
      throw new Error("source broke");
    }
    const conn = await connected();
    const copying = conn.bulkInsert({ table: "t", rows: rows() }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(stub.sent).toHaveLength(1));
    // The read ahead has failed by now; the connection must outlive the send.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stub.events).not.toContain("close");
    release();
    const err = (await copying) as SybaseBulkCopyError;
    expect(err.message).toMatch(/reading the rows failed: source broke/);
    expect(stub.events.slice(-2)).toEqual(["send 10000 commit 0", "close"]);
  });

  it("refuses other statements on the connection until the copy is over", async () => {
    twoColumns();
    let release!: () => void;
    stub.onSend = () =>
      new Promise(resolve => {
        release = () =>
          resolve({ rowsSent: 1, rejectedCount: 0, rejected: [], committed: 1, discard: false });
      });
    const conn = await connected();
    const copying = conn.bulkInsert({ table: "t", rows: [[1, "a"]] });
    const query = conn.query("select 1");
    await vi.waitFor(() => expect(stub.sent).toHaveLength(1));
    expect(stub.queries.filter(q => q === "select 1")).toEqual([]);
    release();
    await copying;
    await query;
    expect(stub.events.slice(-2)).toEqual(["send 1 commit 2", "query select 1"]);
  });
});

describe("bulkInsert: deadline", () => {
  // Waiting for rows, nothing native may be under way: the deadline's timer is
  // then all that settles the call, so it must keep the process up.
  it("keeps the process up for its deadline while the source stalls", async () => {
    twoColumns();
    let next!: () => void;
    const reached = new Promise<void>(resolve => (next = resolve));
    const stalled = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          next();
          return new Promise<never>(() => {});
        }
      })
    };
    const conn = await connected();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = real(...args);
      if (args[1] === 200) {
        timers.push(timer);
      }
      return timer;
    }) as typeof setTimeout);
    try {
      const copying = conn
        .bulkInsert({ table: "t", rows: stalled, hardTimeoutMs: 200 })
        .catch((e: unknown) => e);
      await reached;
      expect(timers).toHaveLength(1);
      expect(timers[0]!.hasRef()).toBe(true);
      expect(((await copying) as SybaseBulkCopyError).cause).toBeInstanceOf(SybaseTimeoutError);
    } finally {
      spy.mockRestore();
    }
  });

  it("abandons a copy whose source stalls past hardTimeoutMs", async () => {
    twoColumns();
    async function* rows() {
      yield [1, "a"];
      yield [2, "b"];
      await new Promise(resolve => setTimeout(resolve, 1_000));
      yield [3, "c"];
    }
    const conn = await connected();
    const started = Date.now();
    const err = (await conn
      .bulkInsert({ table: "t", rows: rows(), batchSize: 1, hardTimeoutMs: 100 })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(Date.now() - started).toBeLessThan(900);
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.message).toMatch(/the deadline passed/);
    expect(err.cause).toBeInstanceOf(SybaseTimeoutError);
    // Both full batches committed before the source stalled.
    expect(err.rowsCommitted).toBe(2);
    expect(err.rowsInDoubt).toBe(0);
    expect(conn.isConnected).toBe(false);
  });

  it("reports a commit still running at the deadline as in doubt", async () => {
    twoColumns();
    stub.onSend = () => new Promise(() => {});
    const conn = await connected();
    const err = (await conn
      .bulkInsert({
        table: "t",
        rows: [
          [1, "a"],
          [2, "b"]
        ],
        hardTimeoutMs: 50
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err.cause).toBeInstanceOf(SybaseTimeoutError);
    expect(err.rowsCommitted).toBe(0);
    expect(err.rowsInDoubt).toBe(2);
    expect(conn.isConnected).toBe(false);
  });

  // A source whose rows are all ready at once never lets the deadline's timer
  // run; the deadline is also checked while reading.
  it("enforces the deadline while reading rows that never yield to the event loop", async () => {
    stub.columns = [column("m", "money")];
    async function* refusedForever() {
      for (;;) {
        yield [1.5]; // refused: a number into money
      }
    }
    const conn = await connected();
    const started = Date.now();
    const err = (await conn
      .bulkInsert({
        table: "t",
        rows: refusedForever(),
        maxErrors: Number.MAX_SAFE_INTEGER,
        hardTimeoutMs: 100
      })
      .catch((e: unknown) => e)) as SybaseBulkCopyError;
    expect(err).toBeInstanceOf(SybaseBulkCopyError);
    expect(err.cause).toBeInstanceOf(SybaseTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(conn.isConnected).toBe(false);
  });

  it("gives each native call what is left of the deadline", async () => {
    twoColumns();
    const conn = await connected();
    await conn.bulkInsert({ table: "t", rows: [[1, "a"]], hardTimeoutMs: 5_000 });
    expect(stub.begins[0]!.hardTimeoutMs).toBeLessThanOrEqual(5_000);
    expect(stub.sent[0]!.hardTimeoutMs).toBeLessThanOrEqual(
      stub.begins[0]!.hardTimeoutMs as number
    );
    expect(stub.sent[0]!.hardTimeoutMs).toBeGreaterThan(4_000);
  });
});

describe("bulkInsert: options", () => {
  it.each([
    ["a table name with a bracket", { table: "[t]" }],
    ["a table name with a space", { table: "t; drop table x" }],
    ["four name parts", { table: "a.b.c.d" }],
    ["an empty owner in a two-part name", { table: ".t" }],
    ["a table name over 92 characters", { table: "t".repeat(93) }],
    ["an empty column list", { columns: [] }],
    ["an empty column name", { columns: [""] }],
    ["rows that are a number", { rows: 5 }],
    ["rows that are null", { rows: null }],
    ["batchSize 0", { batchSize: 0 }],
    ["a fractional batchSize", { batchSize: 1.5 }],
    ["negative expectedRows", { expectedRows: -1 }],
    ["negative maxErrors", { maxErrors: -1 }],
    ["timeoutSeconds 0", { timeoutSeconds: 0 }],
    ["hardTimeoutMs 0", { hardTimeoutMs: 0 }],
    ["a non-boolean keepIdentity", { keepIdentity: "yes" }],
    ["a non-boolean ignoreDefaults", { ignoreDefaults: 1 }],
    ["a non-boolean allowConstraintBypass", { allowConstraintBypass: "yes" }]
  ])("rejects %s before anything is sent", async (_name, bad) => {
    twoColumns();
    const conn = await connected();
    await expect(
      conn.bulkInsert({ table: "t", rows: [], ...(bad as object) } as never)
    ).rejects.toThrow();
    expect(stub.begins).toHaveLength(0);
    expect(conn.isConnected).toBe(true);
  });

  it.each(["t", "dbo.t", "db..t", "db.dbo.t", "#t", "tempdb..dsb_bcp_probe"])(
    "accepts the table name %s",
    async table => {
      twoColumns();
      const conn = await connected();
      await conn.bulkInsert({ table, rows: [] });
      expect(stub.begins[0]!.table).toBe(table);
    }
  );
});

describe("bulkInsert on the pool and db", () => {
  it("runs on a pooled connection and logs it", async () => {
    twoColumns();
    const logged: unknown[] = [];
    const db = createSybaseDrizzle({ ...config, logger: { query: log => logged.push(log) } });
    const result = await db.bulkInsert({ table: "tempdb..t", rows: [[1, "a"]] });
    expect(result.rowsCopied).toBe(1);
    expect(logged).toEqual([
      expect.objectContaining({ sql: "insert bulk tempdb..t", rowCount: 1 })
    ]);
    expect((logged[0] as { error?: Error }).error).toBeUndefined();
    expect(db.pool.metrics.totalQueriesExecuted).toBe(1);
    expect(db.pool.idle).toBe(1);
    await db.close();
  });

  it("logs the rows committed before a copy failed", async () => {
    twoColumns();
    stub.onSend = (_chunk, index) => {
      if (index === 1) {
        throw nativeError("Msg 2601: duplicate key", { outcome: "failed" });
      }
      return { rowsSent: 2, rejectedCount: 0, rejected: [], committed: 2, discard: false };
    };
    const logged: { rowCount: number; error?: Error }[] = [];
    const db = createSybaseDrizzle({ ...config, logger: { query: log => logged.push(log) } });
    await expect(
      db.bulkInsert({
        table: "t",
        rows: Array.from({ length: 4 }, (_, i) => [i, "x"]),
        batchSize: 2
      })
    ).rejects.toBeInstanceOf(SybaseBulkCopyError);
    expect(logged).toEqual([expect.objectContaining({ rowCount: 2, error: expect.any(Error) })]);
    await db.close();
  });

  it("discards the pooled connection a failed copy closed", async () => {
    twoColumns();
    stub.onSend = () => {
      throw nativeError("Msg 2601: duplicate key", { outcome: "failed" });
    };
    const db = createSybaseDrizzle(config);
    await expect(db.bulkInsert({ table: "t", rows: [[1, "a"]] })).rejects.toBeInstanceOf(
      SybaseBulkCopyError
    );
    expect(db.pool.size).toBe(0);
    expect(db.pool.metrics.totalQueryErrors).toBe(1);
    await db.close();
  });

  it("validates the options before taking a connection", async () => {
    const db = createSybaseDrizzle(config);
    await expect(db.bulkInsert({ table: "bad name", rows: [] })).rejects.toThrow(TypeError);
    // A #temp table is named on its own: qualified, the session's own
    // temporary database would be looked past.
    for (const table of ["dbo.#t", "tempdb..#t", "db.dbo.#t"]) {
      await expect(db.bulkInsert({ table, rows: [] })).rejects.toThrow(TypeError);
    }
    expect(db.pool.metrics.totalConnectionsCreated).toBe(0);
    await db.close();
  });

  it("is on withConnection's handle, for #temp tables, and not on a transaction's", async () => {
    twoColumns();
    const db = createSybaseDrizzle(config);
    const result = await db.withConnection(async conn => {
      await conn.executeRaw("create table #stage (k int, v char(10))");
      return conn.bulkInsert({ table: "#stage", rows: [[1, "a"]] });
    });
    expect(result.rowsCopied).toBe(1);
    await db.transaction(async tx => {
      expect("bulkInsert" in tx).toBe(false);
    });
    await db.close();
  });

  // Committed, then the connection closed as its settings could not be put
  // back: nothing uncommitted was lost, so the copy's result stands.
  it("returns withConnection's result when a copy completed but closed the connection", async () => {
    twoColumns();
    stub.onSend = () => ({
      rowsSent: 1,
      rejectedCount: 0,
      rejected: [],
      committed: 1,
      discard: true
    });
    const db = createSybaseDrizzle(config);
    const result = await db.withConnection(conn =>
      conn.bulkInsert({ table: "#stage", rows: [[1, "a"]] })
    );
    expect(result.rowsCopied).toBe(1);
    expect(db.pool.size).toBe(0);
    // Any other loss of the connection still cannot be reported as success.
    await expect(
      db.withConnection(async conn => {
        await conn.executeRaw("select 1");
        stub.opened.clear();
      })
    ).rejects.toThrow(/could not be checked/);
    await db.close();
  });

  it("refuses a withConnection handle used after its callback", async () => {
    twoColumns();
    const db = createSybaseDrizzle(config);
    let kept: { bulkInsert: typeof db.bulkInsert } | undefined;
    await db.withConnection(async conn => {
      kept = conn;
    });
    await expect(kept!.bulkInsert({ table: "t", rows: [] })).rejects.toThrow(/has ended/);
    await db.close();
  });
});
