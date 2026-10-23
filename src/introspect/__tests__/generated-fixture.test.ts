/**
 * Keeps `fixtures/generated-schema.ts` identical to what the generator emits
 * for a schema that covers every type in the registry, so the fixture can be
 * compiled: `generated-schema.test-d.ts` checks there that the Zod-derived row
 * types the generator publishes equal the types inferred from its tables.
 *
 * After an intended generator change, refresh the fixture with
 * `UPDATE_FIXTURES=1 pnpm exec vitest run src/introspect/__tests__/generated-fixture.test.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateSchemaCode } from "../codegen.js";
import { SYBASE_TYPE_MAP } from "../type-map.js";
import type { ColumnMeta, TableMeta } from "../types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/generated-schema.ts", import.meta.url));

let colid = 0;
const col = (
  overrides: Partial<ColumnMeta> & Pick<ColumnMeta, "name" | "typeName">
): ColumnMeta => ({
  colid: ++colid,
  length: 0,
  precision: null,
  scale: null,
  isNullable: false,
  isIdentity: false,
  defaultValue: null,
  ...overrides
});

/** Every registry type, nullable and not. */
const everyType: TableMeta = {
  name: "EVERY_TYPE",
  owner: "dbo",
  indexes: [],
  columns: Object.entries(SYBASE_TYPE_MAP).flatMap(([typeName, mapping]) => {
    const size =
      mapping.size === "length"
        ? { length: 20 }
        : mapping.size === "precision"
          ? { precision: 10, scale: 2 }
          : {};
    return [
      col({ name: `${typeName.toUpperCase()}_NN`, typeName, ...size }),
      col({ name: `${typeName.toUpperCase()}_N`, typeName, ...size, isNullable: true })
    ];
  })
};

/** Fixed-point widths on each side of what a double holds exactly. */
const widths: TableMeta = {
  name: "WIDTHS",
  owner: "dbo",
  indexes: [],
  columns: [
    col({ name: "NO_WIDTH", typeName: "numeric" }),
    col({ name: "EXACT_INT", typeName: "numeric", precision: 15, scale: 0 }),
    col({ name: "EXACT_FRAC", typeName: "decimal", precision: 15, scale: 4 }),
    col({ name: "WIDE_INT", typeName: "numeric", precision: 16, scale: 0 }),
    col({ name: "WIDE_FRAC", typeName: "numeric", precision: 38, scale: 10 })
  ]
};

/** Identity, database defaults and nullability, as they decide insert optionality. */
const defaults: TableMeta = {
  name: "DEFAULTS",
  owner: "dbo",
  indexes: [{ indexName: "pk_defaults", isPrimary: true, isUnique: true, columns: ["ID"] }],
  columns: [
    col({ name: "ID", typeName: "int", isIdentity: true }),
    col({ name: "REQUIRED", typeName: "varchar", length: 10 }),
    col({ name: "DEFAULTED", typeName: "datetime", defaultValue: "DEFAULT getdate()" }),
    col({
      name: "NULLABLE_DEFAULTED",
      typeName: "int",
      isNullable: true,
      defaultValue: "DEFAULT 0"
    }),
    col({ name: "OPTIONAL", typeName: "money", isNullable: true })
  ]
};

const normalize = (code: string) => code.replace(/^ \* Generated: .*$/m, " * Generated: <fixture>");

describe("generated schema fixture", () => {
  it("matches the generator's output", () => {
    const { code } = generateSchemaCode([everyType, widths, defaults], "fixture", {
      // A single-byte server charset, like the ASE the integration tests use.
      nchar: 1,
      unichar: 2
    });
    const expected = normalize(code);
    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(FIXTURE, expected);
    }
    expect(readFileSync(FIXTURE, "utf8")).toBe(expected);
  });
});
