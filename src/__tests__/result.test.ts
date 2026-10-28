/**
 * Decoding the addon's column-by-column result (see `build_result` in
 * `binding.c`) into columns and rows.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { parseSybaseDateTime } from "../datetime.js";
import { buildRows, toColumnarResult, toRowResult } from "../result.js";
import type { NativeColumn, NativeResult } from "../result.js";

const native = (columns: [name: string, type: string, column: NativeColumn][], rowCount: number) =>
  ({
    columns: columns.map(([name]) => name),
    columnTypes: columns.map(([, type]) => type),
    data: columns.map(([, , column]) => column),
    rowCount,
    affectedRows: 0
  }) satisfies NativeResult;

const mask = (...bits: number[]) => Uint8Array.from(bits);

describe("text columns", () => {
  it("splits runs back into one value per row, with NULLs in place", () => {
    const raw = native(
      [["s", "varchar", { kind: "text", values: ["a\0\0c", "d\0"], nulls: mask(0, 0, 0, 0, 1) }]],
      5
    );
    expect(toColumnarResult(raw).columns[0]!.values).toEqual(["a", "", "c", "d", null]);
    expect(toRowResult(raw).rows).toEqual([
      { s: "a" },
      { s: "" },
      { s: "c" },
      { s: "d" },
      { s: null }
    ]);
  });

  it("decodes an empty result, which arrives as no runs at all", () => {
    const raw = native([["s", "varchar", { kind: "text", values: [], nulls: undefined }]], 0);
    expect(toColumnarResult(raw).columns[0]!.values).toEqual([]);
    expect(toRowResult(raw).rows).toEqual([]);
  });

  it("refuses a column that does not split into one value per row", () => {
    const raw = native([["s", "varchar", { kind: "text", values: ["a\0b"], nulls: undefined }]], 3);
    expect(() => toRowResult(raw)).toThrow(/decoded to 2 values for 3 rows/);
  });
});

describe("fixed-width columns", () => {
  const raw = native(
    [
      ["i", "int", { kind: "int32", values: Int32Array.of(1, 0, -3), nulls: mask(0, 1, 0) }],
      ["f", "float", { kind: "float64", values: Float64Array.of(0.5, 2, 0), nulls: mask(0, 0, 1) }],
      [
        "b",
        "bigint",
        { kind: "int64", values: BigInt64Array.of(-(2n ** 63n), 0n, 9n), nulls: undefined }
      ],
      [
        "u",
        "ubigint",
        { kind: "uint64", values: BigUint64Array.of(2n ** 64n - 1n, 0n, 1n), nulls: mask(0, 1, 0) }
      ],
      ["t", "bit", { kind: "bool", values: Uint8Array.of(1, 0, 0), nulls: mask(0, 0, 1) }]
    ],
    3
  );

  it("keeps typed arrays and their NULL masks in columns", () => {
    const [i, f, b, u, t] = toColumnarResult(raw).columns;
    expect(i!.values).toEqual(Int32Array.of(1, 0, -3));
    expect(i!.nulls).toEqual(mask(0, 1, 0));
    expect(f!.values).toBeInstanceOf(Float64Array);
    expect(b!.values).toBeInstanceOf(BigInt64Array);
    expect(b!.nulls).toBeUndefined();
    expect(u!.values).toBeInstanceOf(BigUint64Array);
    // bit has no typed form that reads as booleans, so it is a plain array.
    expect(t!.values).toEqual([true, false, null]);
  });

  it("reads masked slots as null in rows", () => {
    expect(toRowResult(raw).rows).toEqual([
      { i: 1, f: 0.5, b: -(2n ** 63n), u: 2n ** 64n - 1n, t: true },
      { i: null, f: 2, b: 0n, u: null, t: false },
      { i: -3, f: null, b: 9n, u: 1n, t: null }
    ]);
  });
});

describe("binary columns", () => {
  const raw = native(
    [
      [
        "b",
        "varbinary",
        {
          kind: "binary",
          values: Buffer.from([0xde, 0xad, 0x01]),
          ends: Float64Array.of(2, 2, 2, 3),
          nulls: mask(0, 1, 0, 0)
        }
      ]
    ],
    4
  );

  it("cuts one Buffer per value, with NULLs in place", () => {
    expect(toRowResult(raw).rows).toEqual([
      { b: Buffer.from([0xde, 0xad]) },
      { b: null },
      { b: Buffer.alloc(0) },
      { b: Buffer.from([0x01]) }
    ]);
  });

  it("gives every value memory of its own", () => {
    const values = toColumnarResult(raw).columns[0]!.values as (Buffer | null)[];
    for (const value of [values[0]!, values[3]!]) {
      expect(Buffer.isBuffer(value)).toBe(true);
      expect(value.byteOffset).toBe(0);
      expect(value.buffer.byteLength).toBe(value.length);
    }
    values[0]![0] = 0;
    expect(raw.data[0]!.values).toEqual(Buffer.from([0xde, 0xad, 0x01]));
  });
});

describe("datetime wall clocks", () => {
  const SYDNEY = "Australia/Sydney";
  // Around both 2016 Sydney transitions: 2016-04-03 03:00 (back to 02:00, so
  // 02:00-03:00 repeats) and 2016-10-02 02:00 (forward to 03:00, so 02:00-03:00
  // does not exist), plus ordinary days and the type's edges.
  const clocks = [
    "1753-01-01 00:00:00.000",
    "1900-01-01 00:00:00.000",
    "2016-04-02 12:00:00.000",
    "2016-04-03 01:59:59.997",
    "2016-04-03 02:00:00.000",
    "2016-04-03 02:30:00.000",
    "2016-04-03 03:00:00.000",
    "2016-10-02 01:59:59.997",
    "2016-10-02 02:00:00.000",
    "2016-10-02 02:30:00.000",
    "2016-10-02 03:00:00.000",
    "2016-06-09 09:48:46.753",
    "9999-12-31 23:59:59.997"
  ];
  const wallClock = (text: string) => parseSybaseDateTime(text, "UTC")!.getTime();
  // A fresh result each time: decoding resolves the wall clocks in place.
  const raw = () =>
    native(
      [
        [
          "dt",
          "datetime",
          {
            kind: "wallclock",
            values: Float64Array.from([...clocks.map(wallClock), 0]),
            nulls: mask(...clocks.map(() => 0), 1)
          }
        ]
      ],
      clocks.length + 1
    );
  const expected = (timeZone: string) =>
    clocks.map(text => parseSybaseDateTime(text, timeZone)!.getTime());

  it.each(["UTC", SYDNEY, "America/New_York"])(
    "resolves exactly as parsing the canonical text does, in %s",
    timeZone => {
      const [column] = toColumnarResult(raw(), timeZone).columns;
      // Epoch milliseconds, with the NULL slot masked.
      expect(column!.values).toEqual(Float64Array.from([...expected(timeZone), 0]));
      expect(column!.nulls?.[clocks.length]).toBe(1);
      expect(toRowResult(raw(), timeZone).rows.map(row => row.dt)).toEqual([
        ...expected(timeZone).map(ms => new Date(ms)),
        null
      ]);
    }
  );

  it("gives every row its own Date", () => {
    const repeated = native(
      [["dt", "datetime", { kind: "wallclock", values: Float64Array.of(0, 0), nulls: undefined }]],
      2
    );
    const [a, b] = toRowResult(repeated, "UTC").rows;
    expect(a!.dt).not.toBe(b!.dt);
  });

  it("refuses wall clocks without a zone to read them in", () => {
    expect(() => toRowResult(raw())).toThrow(/without a time zone/);
  });
});

describe("rows", () => {
  it("lets a later column of the same name overwrite an earlier one", () => {
    const raw = native(
      [
        ["a", "int", { kind: "int32", values: Int32Array.of(1), nulls: undefined }],
        ["b", "int", { kind: "int32", values: Int32Array.of(2), nulls: undefined }],
        ["a", "int", { kind: "int32", values: Int32Array.of(3), nulls: undefined }]
      ],
      1
    );
    const [row] = toRowResult(raw).rows;
    expect(row).toEqual({ a: 3, b: 2 });
    expect(Object.keys(row!)).toEqual(["a", "b"]);
  });

  it("keeps a column named __proto__ as a field, not the prototype", () => {
    const raw = native(
      [["__proto__", "varchar", { kind: "text", values: ["x"], nulls: undefined }]],
      1
    );
    const [row] = toRowResult(raw).rows;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe("x");
  });

  it("embeds any column name safely", () => {
    const name = `"]: 1 }; throw new Error("injected"); //\u2028\\`;
    const raw = native([[name, "varchar", { kind: "text", values: ["v"], nulls: undefined }]], 1);
    expect(toRowResult(raw).rows[0]![name]).toBe("v");
  });
});

// Last: once the runtime has refused `new Function`, builders stay generic.
describe("without code generation", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("builds the same rows field by field", () => {
    vi.stubGlobal(
      "Function",
      new Proxy(Function, {
        construct: () => {
          throw new EvalError("Code generation from strings disallowed for this context");
        }
      })
    );
    const raw = native(
      [
        ["n", "int", { kind: "int32", values: Int32Array.of(7, 0), nulls: mask(0, 1) }],
        ["__proto__", "varchar", { kind: "text", values: ["x\0y"], nulls: undefined }],
        ["generic_only", "varchar", { kind: "text", values: ["p\0q"], nulls: undefined }],
        ["dt", "datetime", { kind: "wallclock", values: Float64Array.of(0, 5), nulls: mask(1, 0) }]
      ],
      2
    );
    const rows = buildRows(toColumnarResult(raw, "UTC"));
    expect(rows.map(row => ({ ...row }))).toEqual([
      { n: 7, ["__proto__"]: "x", generic_only: "p", dt: null },
      { n: null, ["__proto__"]: "y", generic_only: "q", dt: new Date(5) }
    ]);
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
  });
});
