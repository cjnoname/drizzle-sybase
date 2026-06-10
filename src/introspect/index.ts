/**
 * Sybase ASE schema introspection — public entry point.
 *
 * Connects to a Sybase database, reads the system catalogs, and returns
 * generated drizzle-sybase source code (table definitions, index metadata and
 * Zod select/insert schemas).
 *
 * @example
 * ```ts
 * import { introspectSybase } from "drizzle-sybase/introspect";
 *
 * const { code, warnings } = await introspectSybase({
 *   host: "sybase-host",
 *   port: 5000,
 *   database: "mydb",
 *   username: "sa",
 *   password: "secret",
 *   tables: ["users", "orders"]
 * });
 * ```
 */

import { writeFileSync } from "node:fs";

import { createSybaseDrizzle } from "../db.js";
import { generateSchemaCode, type GeneratedCode } from "./codegen.js";
import { fetchColumns, fetchIndexes, fetchTables } from "./fetch.js";
import type { IntrospectConfig, IntrospectDb, TableMeta } from "./types.js";

export type { IntrospectConfig, IntrospectDb, ColumnMeta, IndexMeta, TableMeta } from "./types.js";
export type { GeneratedCode } from "./codegen.js";
export { SYBASE_TYPE_MAP } from "./type-map.js";

/**
 * Introspect a Sybase database using an already-connected db handle.
 *
 * Useful when the caller owns connection lifecycle / credentials (e.g. fetched
 * from a secrets manager) and wants to reuse an existing pool. The handle is
 * not closed by this function.
 */
export async function introspectWith(
  db: IntrospectDb,
  options: { database: string; tables?: string[]; owner?: string }
): Promise<GeneratedCode> {
  const tables = await fetchTables(db, options.database, options.tables, options.owner);

  const tableMetas: TableMeta[] = [];
  for (const { name, owner } of tables) {
    const [columns, indexes] = await Promise.all([
      fetchColumns(db, options.database, name),
      fetchIndexes(db, options.database, name)
    ]);
    tableMetas.push({ name, owner, columns, indexes });
  }

  return generateSchemaCode(tableMetas, options.database);
}

/**
 * Introspect a Sybase database and return generated code as a string.
 *
 * Opens a short-lived pool, introspects, and always closes the pool.
 */
export async function introspectSybase(config: IntrospectConfig): Promise<GeneratedCode> {
  const db = createSybaseDrizzle({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    max: 2,
    timeout: config.timeout ?? 30
  });

  try {
    return await introspectWith(db, {
      database: config.database,
      tables: config.tables,
      owner: config.owner
    });
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  drizzle-sybase-introspect --host=<host> --port=5000 --database=<db> \\
    --username=<user> --password=<pass> \\
    [--tables=TABLE1,TABLE2] [--owner=dbo] [--out=path/to/output.ts]

Or set env vars: SYBASE_HOST, SYBASE_PORT, SYBASE_DATABASE, SYBASE_USERNAME, SYBASE_PASSWORD, SYBASE_TABLES`;

/**
 * CLI entry point. Parses `process.argv` and runs introspection, printing to
 * stdout or writing to `--out`.
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parseArg = (name: string): string | undefined => {
    const arg = argv.find(a => a.startsWith(`--${name}=`));
    return arg?.split("=").slice(1).join("=");
  };

  const host = parseArg("host") ?? process.env.SYBASE_HOST;
  const portRaw = parseArg("port") ?? process.env.SYBASE_PORT ?? "5000";
  const port = Number(portRaw);
  const database = parseArg("database") ?? process.env.SYBASE_DATABASE;
  const username = parseArg("username") ?? process.env.SYBASE_USERNAME;
  const password = parseArg("password") ?? process.env.SYBASE_PASSWORD;
  const tables = (parseArg("tables") ?? process.env.SYBASE_TABLES)
    ?.split(",")
    .map(t => t.trim())
    .filter(Boolean);
  const owner = parseArg("owner");
  const out = parseArg("out");

  if (!host || !database || !username || !password) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid port: "${portRaw}". Expected an integer in 1-65535.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Connecting to ${host}:${port}/${database}...`);
  const { code, warnings } = await introspectSybase({
    host,
    port,
    database,
    username,
    password,
    tables,
    owner
  });

  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }

  if (out) {
    writeFileSync(out, code, "utf-8");
    console.log(`Schema written to ${out}`);
  } else {
    console.log("\n" + code);
  }
}
