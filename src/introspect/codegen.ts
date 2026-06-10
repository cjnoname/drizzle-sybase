/**
 * Generate drizzle-sybase source code (table definitions, index metadata and
 * Zod schemas) from introspected {@link TableMeta}.
 *
 * All type decisions are delegated to the shared {@link SYBASE_TYPE_MAP}
 * registry so the builder, Zod and import generators can never disagree.
 */

import { effectiveLength, resolveMapping, type TypeMapping } from "./type-map.js";
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

function renderZodType(col: ColumnMeta, mapping: TypeMapping): string {
  let zod: string;
  switch (mapping.value) {
    case "number":
      zod = "z.number()";
      break;
    case "boolean":
      zod = "z.boolean()";
      break;
    case "date":
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
    return `  ${memberKey(toCamelCase(col.name))}: ${renderZodType(col, mapping)}`;
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
      let zod = renderZodType(col, mapping);
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

/** drizzle-sybase column factories, in a stable declaration order for imports. */
const FACTORY_ORDER = [
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "varchar",
  "nvarchar",
  "char",
  "nchar",
  "text",
  "ntext",
  "datetime",
  "smalldatetime",
  "numeric",
  "decimal",
  "float",
  "real",
  "money",
  "smallmoney",
  "bit",
  "binary",
  "varbinary",
  "image"
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
  for (const table of tables) {
    lines.push(generateInsertSchema(table));
    lines.push("");
  }

  return { code: lines.join("\n"), warnings };
}
