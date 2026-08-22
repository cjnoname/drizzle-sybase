/**
 * Generate drizzle-sybase source code (table definitions, index metadata and
 * Zod schemas) from introspected {@link TableMeta}.
 *
 * All type decisions are delegated to the shared {@link SYBASE_TYPE_MAP}
 * registry so the builder, Zod and import generators can never disagree.
 */

import {
  decimalRepresentation,
  effectiveLength,
  resolveMapping,
  SYBASE_TYPE_MAP,
  type TypeMapping
} from "./type-map.js";
import type { ColumnMeta, TableMeta } from "./types.js";

/**
 * Convert a SNAKE_CASE / snake_case catalog name to camelCase.
 *
 * Only an underscore *between* characters introduces a hump; a leading
 * underscore is preserved (so `_internal` stays `_internal` rather than
 * collapsing to `internal`/`Internal`).
 */
export function toCamelCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/([^_])_([a-z0-9])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Make a string safe to use as a TypeScript identifier (variable / type name).
 *
 * Sybase identifiers may legally start with a digit (e.g. `[2024_data]`), which
 * is not a valid JS/TS identifier, and may collide with reserved words. A `$`
 * prefix is added when the name would otherwise be invalid or reserved.
 */
function safeIdentifier(name: string): string {
  if (!TS_IDENTIFIER.test(name) || RESERVED_WORDS.has(name)) {
    return "$" + name.replace(/[^A-Za-z0-9_$]/g, "_");
  }
  return name;
}

/** Render an object-literal property key, quoting it when not a bare identifier. */
function memberKey(name: string): string {
  return TS_IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Capitalise the first character (used to build PascalCase type names). */
function capitalize(name: string): string {
  return name.length > 0 ? name[0].toUpperCase() + name.slice(1) : name;
}

const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "let",
  "static",
  "yield",
  "await",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public"
]);

/** Result of code generation, including any non-fatal diagnostics. */
export interface GeneratedCode {
  code: string;
  /** Warnings, e.g. columns that fell back to `varchar` for an unmapped type. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Column builder rendering
// ---------------------------------------------------------------------------

function renderColumnBuilder(col: ColumnMeta, mapping: TypeMapping): string {
  const colName = JSON.stringify(col.name);
  let builder: string;
  switch (mapping.size) {
    case "length":
      builder = `${mapping.factory}(${colName}, { length: ${effectiveLength(col, mapping)} })`;
      break;
    case "precision": {
      // precision/scale should always be present for numeric/decimal, but guard
      // against null catalog values rather than emitting `precision: null`.
      const opts: string[] = [];
      if (col.precision != null) {
        opts.push(`precision: ${col.precision}`);
      }
      if (col.scale != null) {
        opts.push(`scale: ${col.scale}`);
      }
      builder =
        opts.length > 0
          ? `${mapping.factory}(${colName}, { ${opts.join(", ")} })`
          : `${mapping.factory}(${colName})`;
      break;
    }
    default:
      builder = `${mapping.factory}(${colName})`;
      break;
  }

  if (col.isIdentity) {
    builder += ".identity()";
  }
  if (!col.isNullable) {
    builder += ".notNull()";
  }
  return builder;
}

// ---------------------------------------------------------------------------
// Zod rendering
// ---------------------------------------------------------------------------

/**
 * Which schema a validator is being rendered for.
 *
 * The two are not mirror images for exact numerics. A select schema must
 * describe what the driver actually hands back, because `z.infer` of it is
 * published as the row type; an insert schema describes what a caller may
 * supply, which is wider because the dialect can serialize numbers, BigInts and
 * digit strings alike.
 */
type SchemaPurpose = "select" | "insert";

/** Identifiers emitted by {@link EXACT_NUMERIC_HELPERS} and used by insert schemas. */
const INTEGER_LITERAL = "integerLiteral";
const DECIMAL_LITERAL = "decimalLiteral";

/**
 * Helpers emitted into the generated file, once, when an insert schema needs
 * them.
 *
 * Exact numeric columns accept a digit string as well as a JS number, because
 * that is what the dialect can serialize and what a select returns — so
 * read-modify-write keeps working. The string has to be a plain decimal literal:
 * anything else is sent as a quoted value and ASE rejects it with Msg 257, so
 * catching it here turns a server error into a validation error.
 */
const EXACT_NUMERIC_HELPERS = [
  "/** A plain integer literal — the string form an exact numeric column accepts. */",
  `const ${INTEGER_LITERAL} = z.string().regex(/^[+-]?\\d+$/, "expected an integer");`,
  "",
  "/** A plain decimal literal — the string form an exact numeric column accepts. */",
  `const ${DECIMAL_LITERAL} = z.string().regex(`,
  `  /^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/,`,
  `  "expected a decimal number"`,
  ");"
].join("\n");

/**
 * Zod validator for a fixed-point column.
 *
 * Reading: the native driver returns `money`, `smallmoney`, `numeric` and
 * `decimal` as strings on purpose, so no digits are lost in transit. Claiming
 * `number` here — even with a coercion that would repair it on `.parse()` —
 * would make the exported row type disagree with what a plain `db.select()`
 * returns.
 *
 * Writing: every JS type the column can hold **without losing digits**, and no
 * others. That rules out `z.coerce.*` in both branches:
 *
 * - `z.coerce.bigint()` would accept `9007199254740993`, a literal JS `number`
 *   that has *already* rounded to ...992 before Zod ever sees it. Coercing it
 *   produces `9007199254740992n` and reports success, which is exactly the
 *   silent digit loss this column layout exists to prevent. So a column too wide
 *   for a double accepts `bigint` or a digit string, never `number`.
 * - `z.coerce.number()` would accept `""`, `true` and `null` (as 0, 1, 0),
 *   because it is `Number(input)` with a type check afterwards.
 *
 * Deliberately not routed through the `string` branch of {@link renderZodType}:
 * that appends `.max(col.length)`, and for a fixed-point column `length` is the
 * storage byte width (numeric(9,0) is 5 bytes), which would reject "123456789".
 */
function renderDecimalZodType(
  col: ColumnMeta,
  mapping: TypeMapping,
  purpose: SchemaPurpose
): string {
  if (purpose === "select") {
    return "z.string()";
  }
  switch (decimalRepresentation(col, mapping)) {
    // Narrow enough that a double holds every value the column can: a number is
    // safe, and so is the string form.
    case "int":
      return `z.union([z.number().int(), ${INTEGER_LITERAL}])`;
    case "number":
      return `z.union([z.number(), ${DECIMAL_LITERAL}])`;
    // Integers wider than a double. A number cannot be trusted here.
    case "bigint":
      return `z.union([z.bigint(), ${INTEGER_LITERAL}])`;
    // Wide and fractional: no JS numeric type is lossless, so digits only.
    default:
      return DECIMAL_LITERAL;
  }
}

function renderZodType(col: ColumnMeta, mapping: TypeMapping, purpose: SchemaPurpose): string {
  let zod: string;
  switch (mapping.value) {
    case "number":
      zod = "z.number()";
      break;
    case "bigint":
      // SYBINT8 is handed over as a BigInt, so reading needs no conversion;
      // writing also takes the digit string form.
      zod = purpose === "select" ? "z.bigint()" : renderDecimalZodType(col, mapping, purpose);
      break;
    case "decimal":
      zod = renderDecimalZodType(col, mapping, purpose);
      break;
    case "boolean":
      zod = "z.boolean()";
      break;
    case "date":
      // datetime columns are always decoded to Date, in the configured server
      // zone (UTC by default), so no coercion is needed in either direction.
      zod = "z.date()";
      break;
    case "buffer":
      zod = "z.instanceof(Buffer)";
      break;
    default: {
      zod = "z.string()";
      const isText = mapping.factory === "text" || mapping.factory === "ntext";
      if (col.length > 0 && !isText) {
        zod += `.max(${effectiveLength(col, mapping)})`;
      }
      break;
    }
  }
  if (col.isNullable) {
    zod += ".nullable()";
  }
  return zod;
}

// ---------------------------------------------------------------------------
// Per-section generators
// ---------------------------------------------------------------------------

function findPrimaryKey(table: TableMeta) {
  return table.indexes.find(i => i.isPrimary);
}

/** Valid TS variable name for a table's exported const. */
function tableVarName(table: TableMeta): string {
  return safeIdentifier(toCamelCase(table.name));
}

/** Valid TS type-name base (PascalCase) for a table's exported types. */
function tableTypeName(table: TableMeta): string {
  return safeIdentifier(capitalize(toCamelCase(table.name)));
}

function generateTableDefinition(table: TableMeta, warnings: string[]): string {
  const varName = tableVarName(table);
  const pk = findPrimaryKey(table);
  const isSingleColumnPk = pk?.columns.length === 1;

  const columnLines = table.columns.map(col => {
    const { mapping, isFallback } = resolveMapping(col.typeName);
    if (isFallback) {
      warnings.push(
        `Table "${table.name}" column "${col.name}": unmapped Sybase type "${col.typeName}" — emitted as varchar(${col.length}). Verify the generated type.`
      );
    }
    let line = `  ${memberKey(toCamelCase(col.name))}: ${renderColumnBuilder(col, mapping)}`;
    if (isSingleColumnPk && pk.columns[0] === col.name) {
      line += ".primaryKey()";
    }
    return line;
  });

  const lines: string[] = [];
  // Composite primary keys cannot be expressed on individual columns; surface
  // them as a comment so the information is not silently lost (it also remains
  // available in the exported `<table>Indexes` constant below).
  if (pk && pk.columns.length > 1) {
    lines.push(`// Composite primary key: ${pk.columns.map(c => toCamelCase(c)).join(", ")}`);
  }
  lines.push(`export const ${varName} = sybaseTable(${JSON.stringify(table.name)}, {`);
  lines.push(columnLines.join(",\n"));
  lines.push("});");
  return lines.join("\n") + "\n";
}

function generateIndexInfo(table: TableMeta): string {
  if (table.indexes.length === 0) {
    return "";
  }
  const varName = tableVarName(table);
  const indexLines = table.indexes.map(idx => {
    const flags: string[] = [];
    if (idx.isPrimary) {
      flags.push("primary: true");
    }
    if (idx.isUnique) {
      flags.push("unique: true");
    }
    const cols = idx.columns.map(c => JSON.stringify(c)).join(", ");
    const flagStr = flags.length > 0 ? ", " + flags.join(", ") : "";
    return `  { name: ${JSON.stringify(idx.indexName)}, columns: [${cols}]${flagStr} }`;
  });

  return `export const ${varName}Indexes = [\n${indexLines.join(",\n")}\n] as const;\n`;
}

function generateSelectSchema(table: TableMeta): string {
  const varName = tableVarName(table);
  const typeName = tableTypeName(table);
  const fieldLines = table.columns.map(col => {
    const { mapping } = resolveMapping(col.typeName);
    return `  ${memberKey(toCamelCase(col.name))}: ${renderZodType(col, mapping, "select")}`;
  });
  return (
    `export const ${varName}Schema = z.object({\n${fieldLines.join(",\n")}\n});\n` +
    `export type ${typeName}Row = z.infer<typeof ${varName}Schema>;\n`
  );
}

function generateInsertSchema(table: TableMeta): string {
  const varName = tableVarName(table);
  const typeName = tableTypeName(table);
  const fieldLines = table.columns
    .filter(col => !col.isIdentity)
    .map(col => {
      const { mapping } = resolveMapping(col.typeName);
      let zod = renderZodType(col, mapping, "insert");
      if (col.isNullable || col.defaultValue) {
        zod += ".optional()";
      }
      return `  ${memberKey(toCamelCase(col.name))}: ${zod}`;
    });
  return (
    `export const ${varName}InsertSchema = z.object({\n${fieldLines.join(",\n")}\n});\n` +
    `export type New${typeName} = z.infer<typeof ${varName}InsertSchema>;\n`
  );
}

// ---------------------------------------------------------------------------
// Import collection (driven by the same registry as everything else)
// ---------------------------------------------------------------------------

/**
 * drizzle-sybase column factories, in a stable declaration order for imports.
 *
 * Derived from the type registry rather than restated, so a new Sybase type can
 * never be mapped to a factory the import list forgets. The registry's insertion
 * order is the declaration order, and `Set` preserves it while collapsing the
 * types that share a factory — `decimal` maps to `numeric`, so it correctly does
 * not appear as a factory of its own.
 */
const FACTORY_ORDER: readonly string[] = [
  ...new Set(Object.values(SYBASE_TYPE_MAP).map(mapping => mapping.factory))
];

function collectImports(tables: TableMeta[]): string[] {
  const used = new Set<string>();
  for (const table of tables) {
    for (const col of table.columns) {
      const { mapping } = resolveMapping(col.typeName);
      used.add(mapping.factory);
    }
  }
  return FACTORY_ORDER.filter(f => used.has(f));
}

// ---------------------------------------------------------------------------
// Top-level generator
// ---------------------------------------------------------------------------

const DIVIDER =
  "// ═══════════════════════════════════════════════════════════════════════════════";

export function generateSchemaCode(tables: TableMeta[], database: string): GeneratedCode {
  const warnings: string[] = [];
  const imports = collectImports(tables);
  const lines: string[] = [];

  lines.push("/**");
  lines.push(" * Auto-generated Sybase schema definitions.");
  lines.push(` * Database: ${database}`);
  lines.push(` * Generated: ${new Date().toISOString()}`);
  lines.push(" *");
  lines.push(" * DO NOT EDIT — re-run introspectSybase to regenerate.");
  lines.push(" */");
  lines.push("");
  const importList = ["sybaseTable", ...imports].join(", ");
  lines.push(`import { ${importList} } from "drizzle-sybase";`);
  lines.push(`import { z } from "zod";`);
  lines.push("");

  lines.push(DIVIDER);
  lines.push("// Table Definitions");
  lines.push(DIVIDER);
  lines.push("");
  for (const table of tables) {
    lines.push(generateTableDefinition(table, warnings));
    lines.push("");
  }

  lines.push(DIVIDER);
  lines.push("// Indexes");
  lines.push(DIVIDER);
  lines.push("");
  for (const table of tables) {
    const indexCode = generateIndexInfo(table);
    if (indexCode) {
      lines.push(indexCode);
      lines.push("");
    }
  }

  lines.push(DIVIDER);
  lines.push("// Zod Schemas (Select)");
  lines.push(DIVIDER);
  lines.push("");
  for (const table of tables) {
    lines.push(generateSelectSchema(table));
    lines.push("");
  }

  lines.push(DIVIDER);
  lines.push("// Zod Schemas (Insert)");
  lines.push(DIVIDER);
  lines.push("");
  const insertSchemas = tables.map(table => generateInsertSchema(table));
  // Emitted only when referenced, so a schema with no exact numeric columns does
  // not carry an unused const.
  if (insertSchemas.some(s => s.includes(INTEGER_LITERAL) || s.includes(DECIMAL_LITERAL))) {
    lines.push(EXACT_NUMERIC_HELPERS);
    lines.push("");
  }
  for (const schema of insertSchemas) {
    lines.push(schema);
    lines.push("");
  }

  return { code: lines.join("\n"), warnings };
}
