/**
 * Introspection unit tests.
 *
 * These verify catalog query construction, metadata parsing and code
 * generation without requiring a real Sybase connection, using a mock db that
 * captures executed SQL and returns scripted rows (mirroring the mock style of
 * the query-builder tests).
 */
import { describe, it, expect } from "vitest";

import { generateSchemaCode, toCamelCase } from "../codegen.js";
import { assertSafeIdentifier, fetchColumns, fetchIndexes, fetchTables } from "../fetch.js";
import { introspectWith, runCli } from "../index.js";
import { decimalRepresentation, resolveMapping, SYBASE_TYPE_MAP } from "../type-map.js";
import type { ColumnMeta, IndexMeta, IntrospectDb, TableMeta } from "../types.js";

// ---------------------------------------------------------------------------
// Mock db
// ---------------------------------------------------------------------------

type Responder = (sql: string) => Record<string, unknown>[];

function createMockDb(responder: Responder) {
  const executed: string[] = [];
  const db: IntrospectDb & { executed: string[] } = {
    executed,
    async executeRaw<T extends Record<string, unknown>>(rawSql: string) {
      executed.push(rawSql);
      const rows = responder(rawSql) as T[];
      return { rows, rowCount: rows.length };
    }
  };
  return db;
}

// ---------------------------------------------------------------------------
// type-map (single source of truth)
// ---------------------------------------------------------------------------

describe("type-map", () => {
  it("maps known types to the matching column factory", () => {
    expect(SYBASE_TYPE_MAP.int.factory).toBe("int");
    expect(SYBASE_TYPE_MAP.varchar.size).toBe("length");
    expect(SYBASE_TYPE_MAP.numeric.size).toBe("precision");
    expect(SYBASE_TYPE_MAP.decimal.factory).toBe("numeric");
    expect(SYBASE_TYPE_MAP.bit.value).toBe("boolean");
    expect(SYBASE_TYPE_MAP.image.value).toBe("buffer");
  });

  it("flags national char types for byte-length halving", () => {
    expect(SYBASE_TYPE_MAP.nvarchar.nationalChar).toBe(true);
    expect(SYBASE_TYPE_MAP.nchar.nationalChar).toBe(true);
    expect(SYBASE_TYPE_MAP.varchar.nationalChar).toBeUndefined();
  });

  it("falls back to varchar for unknown types", () => {
    const { mapping, isFallback } = resolveMapping("xmltype");
    expect(isFallback).toBe(true);
    expect(mapping.factory).toBe("varchar");
  });

  it("does not resolve inherited Object prototype keys as types", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const { mapping, isFallback } = resolveMapping(key);
      expect(isFallback).toBe(true);
      expect(mapping.factory).toBe("varchar");
    }
  });

  // The catalog reports no precision for money/smallmoney, so the widths fixed
  // by the types themselves have to come from the registry.
  it("supplies the intrinsic width of the money types", () => {
    expect(SYBASE_TYPE_MAP.money.width).toEqual({ precision: 19, scale: 4 });
    expect(SYBASE_TYPE_MAP.smallmoney.width).toEqual({ precision: 10, scale: 4 });
    expect(SYBASE_TYPE_MAP.numeric.width).toBeUndefined();
  });

  // 64-bit ints reach 19 digits, past what a double holds exactly, so the driver
  // hands them over as a real BigInt rather than as digits to be parsed.
  it("marks bigint as arriving as a BigInt", () => {
    expect(SYBASE_TYPE_MAP.bigint.value).toBe("bigint");
    expect(SYBASE_TYPE_MAP.bigint.width).toEqual({ precision: 19, scale: 0 });
    // The narrower integer types do fit a double exactly.
    expect(SYBASE_TYPE_MAP.int.value).toBe("number");
    expect(SYBASE_TYPE_MAP.smallint.value).toBe("number");
  });

  // The driver returns these as strings to preserve precision, so they cannot be
  // lumped in with the types that arrive as JS numbers.
  it("marks the exact fixed-point types as decimal", () => {
    expect(SYBASE_TYPE_MAP.numeric.value).toBe("decimal");
    expect(SYBASE_TYPE_MAP.decimal.value).toBe("decimal");
    expect(SYBASE_TYPE_MAP.money.value).toBe("decimal");
    expect(SYBASE_TYPE_MAP.smallmoney.value).toBe("decimal");
    // float/real do arrive as doubles.
    expect(SYBASE_TYPE_MAP.float.value).toBe("number");
    expect(SYBASE_TYPE_MAP.real.value).toBe("number");
  });
});

describe("decimalRepresentation", () => {
  const decimalCol = (precision: number | null, scale: number | null): ColumnMeta =>
    col({ name: "N", typeName: "numeric", precision, scale });

  it.each([
    // Integers are exact in a double up to 15 digits; numeric(16,0) max
    // 9999999999999999 already reads back as 10000000000000000.
    [15, 0, "int"],
    [1, 0, "int"],
    [16, 0, "bigint"],
    [38, 0, "bigint"],
    // A fraction that fits a double round-trips exactly via toFixed.
    [15, 2, "number"],
    [7, 4, "number"],
    // Too wide and fractional: no lossless JS numeric type exists.
    [19, 4, "string"],
    [38, 10, "string"]
  ])("maps numeric(%i,%i) to %s", (precision, scale, expected) => {
    expect(decimalRepresentation(decimalCol(precision, scale), SYBASE_TYPE_MAP.numeric)).toBe(
      expected
    );
  });

  it("treats a missing scale as 0", () => {
    expect(decimalRepresentation(decimalCol(9, null), SYBASE_TYPE_MAP.numeric)).toBe("int");
  });

  // An unknown width must not be guessed at: string is the only representation
  // that cannot lose anything.
  it.each([null, 0, -1])("falls back to string for precision %j", precision => {
    expect(decimalRepresentation(decimalCol(precision, 2), SYBASE_TYPE_MAP.numeric)).toBe("string");
  });

  it("uses the intrinsic width for money types over the catalog's", () => {
    // money is (19,4) — 19 significant digits do not fit a double.
    expect(
      decimalRepresentation(col({ name: "M", typeName: "money" }), SYBASE_TYPE_MAP.money)
    ).toBe("string");
    // smallmoney is (10,4), which does.
    expect(
      decimalRepresentation(col({ name: "M", typeName: "smallmoney" }), SYBASE_TYPE_MAP.smallmoney)
    ).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// toCamelCase
// ---------------------------------------------------------------------------

describe("toCamelCase", () => {
  it("converts snake/upper case", () => {
    expect(toCamelCase("WORK_REG_BATCH")).toBe("workRegBatch");
    expect(toCamelCase("PDOF")).toBe("pdof");
    expect(toCamelCase("right_holder_id")).toBe("rightHolderId");
  });

  it("preserves a leading underscore instead of swallowing it", () => {
    expect(toCamelCase("_INTERNAL")).toBe("_internal");
    expect(toCamelCase("__x")).toBe("__x");
  });
});

// ---------------------------------------------------------------------------
// assertSafeIdentifier
// ---------------------------------------------------------------------------

describe("assertSafeIdentifier", () => {
  it("accepts valid identifiers", () => {
    expect(() => assertSafeIdentifier("my_table1", "table")).not.toThrow();
  });

  it("rejects injection attempts and empties", () => {
    expect(() => assertSafeIdentifier("a'; DROP TABLE x--", "table")).toThrow(/Unsafe table/);
    expect(() => assertSafeIdentifier("", "table")).toThrow();
    expect(() => assertSafeIdentifier(undefined, "owner")).toThrow();
    expect(() => assertSafeIdentifier("a".repeat(129), "table")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchTables
// ---------------------------------------------------------------------------

describe("fetchTables", () => {
  it("queries sysobjects and maps rows", async () => {
    const db = createMockDb(() => [{ name: "USERS", owner: "dbo" }]);
    const tables = await fetchTables(db, "mydb", undefined, undefined);
    expect(tables).toEqual([{ name: "USERS", owner: "dbo" }]);
    expect(db.executed[0]).toContain("mydb..sysobjects");
    expect(db.executed[0]).toContain("o.type = 'U'");
  });

  it("applies table and owner filters with escaped literals", async () => {
    const db = createMockDb(() => []);
    await fetchTables(db, "mydb", ["A", "B"], "dbo");
    expect(db.executed[0]).toContain("o.name IN ('A', 'B')");
    expect(db.executed[0]).toContain("u.name = 'dbo'");
  });

  it("validates identifiers before querying", async () => {
    const db = createMockDb(() => []);
    await expect(fetchTables(db, "bad db", undefined)).rejects.toThrow(/Unsafe database/);
    await expect(fetchTables(db, "mydb", ["ok", "no;drop"])).rejects.toThrow(/Unsafe table/);
  });

  it("defaults a missing owner to empty string", async () => {
    const db = createMockDb(() => [{ name: "T", owner: null }]);
    const tables = await fetchTables(db, "mydb");
    expect(tables[0].owner).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fetchColumns
// ---------------------------------------------------------------------------

describe("fetchColumns", () => {
  it("parses nullability/identity bit masks and joins defaults", async () => {
    const db = createMockDb(sql => {
      if (sql.includes("syscomments")) {
        return [{ col_name: "STATUS", default_text: " 'A' " }];
      }
      return [
        { name: "ID", colid: 1, type_name: "INT", length: 4, prec: null, scale: null, status: 128 },
        {
          name: "NAME",
          colid: 2,
          type_name: "VARCHAR",
          length: 50,
          prec: null,
          scale: null,
          status: 8
        },
        {
          name: "STATUS",
          colid: 3,
          type_name: "CHAR",
          length: 1,
          prec: null,
          scale: null,
          status: 0
        }
      ];
    });

    const cols = await fetchColumns(db, "mydb", "USERS");
    expect(cols[0]).toMatchObject({
      name: "ID",
      typeName: "int",
      isIdentity: true,
      isNullable: false
    });
    expect(cols[1]).toMatchObject({ name: "NAME", typeName: "varchar", isNullable: true });
    expect(cols[2]).toMatchObject({ name: "STATUS", defaultValue: "'A'", isNullable: false });
  });

  it("throws when the base system type cannot be resolved", async () => {
    const db = createMockDb(sql => {
      if (sql.includes("syscomments")) {
        return [];
      }
      return [
        { name: "C", colid: 1, type_name: null, length: 0, prec: null, scale: null, status: 0 }
      ];
    });
    await expect(fetchColumns(db, "mydb", "T")).rejects.toThrow(/base system type/);
  });
});

// ---------------------------------------------------------------------------
// fetchIndexes (single round-trip per index)
// ---------------------------------------------------------------------------

describe("fetchIndexes", () => {
  it("resolves all key columns in one query per index", async () => {
    const indexColQueries: string[] = [];
    const db = createMockDb(sql => {
      if (sql.includes("sysindexes") && sql.includes("keycnt")) {
        return [{ index_name: "pk_users", indid: 1, status: 2 | 2048, keycnt: 2 }];
      }
      if (sql.includes("index_col")) {
        indexColQueries.push(sql);
        return [
          { keyno: 1, col_name: "TENANT_ID" },
          { keyno: 2, col_name: "ID" }
        ];
      }
      return [];
    });

    const indexes = await fetchIndexes(db, "mydb", "USERS");
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toMatchObject({
      isPrimary: true,
      isUnique: true,
      columns: ["TENANT_ID", "ID"]
    });
    // Exactly one round-trip for the two key columns (not one per column).
    expect(indexColQueries).toHaveLength(1);
    expect(indexColQueries[0]).toContain("UNION ALL");
  });

  it("stops at the first null key column", async () => {
    const db = createMockDb(sql => {
      if (sql.includes("keycnt")) {
        return [{ index_name: "ix", indid: 2, status: 0, keycnt: 3 }];
      }
      if (sql.includes("index_col")) {
        return [
          { keyno: 1, col_name: "A" },
          { keyno: 2, col_name: null },
          { keyno: 3, col_name: "C" }
        ];
      }
      return [];
    });
    const indexes = await fetchIndexes(db, "mydb", "T");
    expect(indexes[0].columns).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// generateSchemaCode
// ---------------------------------------------------------------------------

function col(overrides: Partial<ColumnMeta> & Pick<ColumnMeta, "name" | "typeName">): ColumnMeta {
  return {
    colid: 1,
    length: 0,
    precision: null,
    scale: null,
    isNullable: false,
    isIdentity: false,
    defaultValue: null,
    ...overrides
  };
}

function table(name: string, columns: ColumnMeta[], indexes: IndexMeta[] = []): TableMeta {
  return { name, owner: "dbo", columns, indexes };
}

describe("generateSchemaCode", () => {
  it("emits a single-column primary key inline", () => {
    const t = table(
      "USERS",
      [
        col({ name: "ID", typeName: "int", isIdentity: true }),
        col({ name: "NAME", typeName: "varchar", length: 50, isNullable: true })
      ],
      [{ indexName: "pk_users", isPrimary: true, isUnique: true, columns: ["ID"] }]
    );
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('export const users = sybaseTable("USERS"');
    expect(code).toContain('id: int("ID").identity().notNull().primaryKey()');
    expect(code).toContain('name: varchar("NAME", { length: 50 })');
    expect(code).toContain("import { sybaseTable, int, varchar }");
  });

  it("preserves composite primary keys via comment and index export", () => {
    const t = table(
      "MDOF",
      [col({ name: "WORK_ID", typeName: "int" }), col({ name: "OFFER_ID", typeName: "int" })],
      [{ indexName: "pk_mdof", isPrimary: true, isUnique: true, columns: ["WORK_ID", "OFFER_ID"] }]
    );
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain("// Composite primary key: workId, offerId");
    // No inline .primaryKey() for composite keys
    expect(code).not.toContain(".primaryKey()");
    expect(code).toContain("export const mdofIndexes = [");
    expect(code).toContain('columns: ["WORK_ID", "OFFER_ID"], primary: true, unique: true');
  });

  it("halves national char byte length", () => {
    const t = table("T", [col({ name: "C", typeName: "nvarchar", length: 100, isNullable: true })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('nvarchar("C", { length: 50 })');
    expect(code).toContain(".max(50)");
  });

  it("renders numeric precision/scale", () => {
    const t = table("T", [col({ name: "AMT", typeName: "numeric", precision: 10, scale: 2 })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('numeric("AMT", { precision: 10, scale: 2 })');
  });

  /** The body of one generated schema, so select and insert can be told apart. */
  const schemaBlock = (code: string, kind: "Schema" | "InsertSchema"): string => {
    const start = code.indexOf(`export const t${kind} = z.object({`);
    expect(start, `t${kind} not found`).toBeGreaterThan(-1);
    return code.slice(start, code.indexOf("});", start));
  };

  // `z.infer` of the select schema is published as the row type, so it has to
  // describe what the driver actually returns: exact numerics come back as digit
  // strings (to keep every digit), and only SYBINT8 arrives as a real BigInt.
  it("describes what the driver returns in the select schema", () => {
    const t = table("T", [
      col({ name: "BIG", typeName: "bigint" }),
      col({ name: "SMALL_INT", typeName: "numeric", precision: 9, scale: 0 }),
      col({ name: "SMALL_FRAC", typeName: "numeric", precision: 7, scale: 4 }),
      col({ name: "WIDE_INT", typeName: "numeric", precision: 20, scale: 0 }),
      col({ name: "AMOUNT", typeName: "money" }),
      col({ name: "SMALL_AMOUNT", typeName: "smallmoney" }),
      col({ name: "WHEN", typeName: "datetime" })
    ]);
    const select = schemaBlock(generateSchemaCode([t], "mydb").code, "Schema");

    expect(select).toContain("big: z.bigint()");
    expect(select).toContain("smallInt: z.string()");
    expect(select).toContain("smallFrac: z.string()");
    expect(select).toContain("wideInt: z.string()");
    expect(select).toContain("amount: z.string()");
    expect(select).toContain("smallAmount: z.string()");
    // datetime columns are always decoded, so no coercion is needed.
    expect(select).toContain("when: z.date()");
    // A coercion in a select schema would paper over a row type that lies.
    expect(select).not.toContain("z.coerce");
  });

  // Writing is the other direction: the dialect serializes numbers, BigInts and
  // digit strings alike, so a caller may supply any of them — but only where the
  // column's width makes that lossless.
  it("accepts exactly the lossless types in the insert schema", () => {
    const t = table("T", [
      col({ name: "BIG", typeName: "bigint" }),
      col({ name: "SMALL_INT", typeName: "numeric", precision: 9, scale: 0 }),
      col({ name: "SMALL_FRAC", typeName: "numeric", precision: 7, scale: 4 }),
      col({ name: "WIDE_INT", typeName: "numeric", precision: 20, scale: 0 }),
      col({ name: "WIDE_FRAC", typeName: "decimal", precision: 19, scale: 4 }),
      col({ name: "AMOUNT", typeName: "money" }),
      col({ name: "SMALL_AMOUNT", typeName: "smallmoney" })
    ]);
    const { code } = generateSchemaCode([t], "mydb");
    const insert = schemaBlock(code, "InsertSchema");

    expect(insert).toContain("smallInt: z.union([z.number().int(), integerLiteral])");
    expect(insert).toContain("smallFrac: z.union([z.number(), decimalLiteral])");
    expect(insert).toContain("smallAmount: z.union([z.number(), decimalLiteral])");
    // Wider than a double: a JS number may already have lost digits before Zod
    // sees it, so only a BigInt or the digit string is accepted.
    expect(insert).toContain("big: z.union([z.bigint(), integerLiteral])");
    expect(insert).toContain("wideInt: z.union([z.bigint(), integerLiteral])");
    // Wide and fractional: no lossless JS numeric type exists.
    expect(insert).toContain("wideFrac: decimalLiteral");
    expect(insert).toContain("amount: decimalLiteral");

    // `z.coerce.bigint()` reports success for 9007199254740993 (already rounded
    // to ...992 as a JS number), and `z.coerce.number()` accepts "" and true.
    expect(code).not.toContain("z.coerce");
    // The string forms are constrained to digits, so a value ASE would reject
    // with Msg 257 fails validation instead.
    expect(code).toContain("const integerLiteral = z.string().regex(/^[+-]?\\d+$/");
    expect(code).toContain("const decimalLiteral = z.string().regex(");
  });

  it("omits the numeric literal helpers when no column needs them", () => {
    const t = table("T", [col({ name: "NAME", typeName: "varchar", length: 10 })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).not.toContain("integerLiteral");
    expect(code).not.toContain("decimalLiteral");
  });

  // `length` on a fixed-point column is the storage byte width (numeric(9,0) is
  // 5 bytes), so a .max() would reject values the column accepts.
  it("never constrains a fixed-point column by its storage byte width", () => {
    const t = table("T", [
      col({ name: "N", typeName: "numeric", length: 5, precision: 9, scale: 0 }),
      col({ name: "M", typeName: "money", length: 8 })
    ]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).not.toContain(".max(");
  });

  it("excludes identity columns from the insert schema and marks optional fields", () => {
    const t = table("T", [
      col({ name: "ID", typeName: "int", isIdentity: true }),
      col({ name: "NOTE", typeName: "varchar", length: 10, isNullable: true }),
      col({ name: "NAME", typeName: "varchar", length: 10 })
    ]);
    const { code } = generateSchemaCode([t], "mydb");
    const insertBlock = code.slice(code.indexOf("InsertSchema"));
    expect(insertBlock).not.toContain("id:");
    expect(insertBlock).toContain("note: z.string().max(10).nullable().optional()");
    expect(insertBlock).toContain("name: z.string().max(10)");
  });

  it("warns and falls back to varchar for unmapped types", () => {
    const t = table("T", [col({ name: "WHEN", typeName: "date", length: 16, isNullable: true })]);
    const { code, warnings } = generateSchemaCode([t], "mydb");
    expect(code).toContain('varchar("WHEN", { length: 16 })');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unmapped Sybase type "date"');
  });

  it("only imports the column factories that are used", () => {
    const t = table("T", [col({ name: "FLAG", typeName: "bit" })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain("import { sybaseTable, bit }");
    expect(code).not.toContain("varchar");
  });

  it("omits precision/scale when the catalog reports null", () => {
    const t = table("T", [col({ name: "N", typeName: "numeric", precision: null, scale: null })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('numeric("N")');
    expect(code).not.toContain("precision: null");
  });

  it("emits precision-only when scale is null", () => {
    const t = table("T", [col({ name: "N", typeName: "numeric", precision: 8, scale: null })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('numeric("N", { precision: 8 })');
  });

  it("clamps a zero/negative catalog length to a valid width", () => {
    const t = table("T", [col({ name: "C", typeName: "varchar", length: 0 })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('varchar("C", { length: 1 })');
    // .max() is skipped entirely for a zero-length column
    expect(code).not.toContain(".max(");
  });

  it("produces valid identifiers for digit-leading table names", () => {
    const t = table("2024_DATA", [col({ name: "ID", typeName: "int" })]);
    const { code } = generateSchemaCode([t], "mydb");
    // Variable / type names must be valid TS identifiers (digit-prefixed -> $).
    expect(code).toContain('export const $2024Data = sybaseTable("2024_DATA"');
    expect(code).toContain("export type $2024DataRow");
    expect(code).toContain("export type New$2024Data");
    expect(code).not.toMatch(/export const 2024Data\b/);
  });

  it("escapes a reserved word used as a table name", () => {
    const t = table("class", [col({ name: "ID", typeName: "int" })]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('export const $class = sybaseTable("class"');
    expect(code).not.toMatch(/export const class\b/);
  });

  it("quotes column field keys that are not bare identifiers", () => {
    const t = table("T", [
      col({ name: "1ST", typeName: "int" }),
      col({ name: "with space", typeName: "varchar", length: 5, isNullable: true })
    ]);
    const { code } = generateSchemaCode([t], "mydb");
    expect(code).toContain('"1st": int("1ST")');
    expect(code).toContain('"with space": varchar("with space", { length: 5 })');
  });

  it("does not emit a dangling comma when no extra column factories are needed", () => {
    const { code } = generateSchemaCode([], "mydb");
    expect(code).toContain('import { sybaseTable } from "drizzle-sybase";');
    expect(code).not.toContain("sybaseTable,  }");
    expect(code).not.toContain("sybaseTable, }");
  });
});

describe("introspectWith", () => {
  it("fetches every table's columns + indexes and generates code", async () => {
    const db = createMockDb(sql => {
      if (sql.includes("sysobjects")) {
        return [{ name: "USERS", owner: "dbo" }];
      }
      if (sql.includes("syscomments")) {
        return [];
      }
      if (sql.includes("syscolumns") && sql.includes("systypes")) {
        return [
          {
            name: "ID",
            colid: 1,
            type_name: "INT",
            length: 4,
            prec: null,
            scale: null,
            status: 128
          }
        ];
      }
      if (sql.includes("sysindexes") && sql.includes("keycnt")) {
        return [{ index_name: "pk", indid: 1, status: 2 | 2048, keycnt: 1 }];
      }
      if (sql.includes("index_col")) {
        return [{ keyno: 1, col_name: "ID" }];
      }
      return [];
    });

    const { code, warnings } = await introspectWith(db, { database: "mydb", tables: ["USERS"] });
    expect(code).toContain('export const users = sybaseTable("USERS"');
    expect(code).toContain('id: int("ID").identity().notNull().primaryKey()');
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

describe("runCli", () => {
  it("prints usage and sets a non-zero exit code when required args are missing", async () => {
    const prevExit = process.exitCode;
    const errors: string[] = [];
    const spy = (msg?: unknown) => {
      errors.push(String(msg));
    };
    const original = console.error;
    console.error = spy as typeof console.error;
    try {
      await runCli([]);
    } finally {
      console.error = original;
    }
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Usage:");
    process.exitCode = prevExit;
  });

  it("rejects a non-numeric port before attempting to connect", async () => {
    const prevExit = process.exitCode;
    const errors: string[] = [];
    const original = console.error;
    console.error = ((msg?: unknown) => errors.push(String(msg))) as typeof console.error;
    try {
      await runCli(["--host=h", "--port=abc", "--database=d", "--username=u", "--password=p"]);
    } finally {
      console.error = original;
    }
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid port");
    process.exitCode = prevExit;
  });
});
