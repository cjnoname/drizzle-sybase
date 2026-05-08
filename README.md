# drizzle-sybase

Drizzle ORM driver for **Sybase ASE** with built-in FreeTDS native bindings.

Zero system dependencies — FreeTDS is statically compiled into the native addon. Works on Lambda (ARM64/x64), containers, and local dev without installing anything.

## Install

```bash
npm install drizzle-sybase
# All platform binaries are included — only the matching one is loaded at runtime
```

## Usage

```ts
import { createSybaseDrizzle, sybaseTable, int, varchar, datetime } from "drizzle-sybase";
import { eq, sql } from "drizzle-orm";

// Define schema
const users = sybaseTable("users", {
  id: int("id").primaryKey().identity(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 200 }),
  createdAt: datetime("created_at")
});

// Create database instance (with connection pool)
const db = createSybaseDrizzle({
  host: "sybase-host",
  port: 5000,
  database: "mydb",
  username: "sa",
  password: "secret",
  max: 10 // max pool connections
});

// SELECT
const rows = await db.select().from(users).where(eq(users.name, "Alice"));

// INSERT (returns @@identity for identity columns)
const { insertId } = await db.insert(users).values({ name: "Bob", email: "bob@test.com" });

// UPDATE
await db.update(users).set({ email: "new@test.com" }).where(eq(users.id, 1));

// DELETE
await db.delete(users).where(eq(users.id, 1));

// Transaction (real BEGIN TRAN / COMMIT on single connection)
await db.transaction(async tx => {
  await tx.insert(users).values({ name: "Charlie" });
  await tx.update(users).set({ name: "Charles" }).where(eq(users.name, "Charlie"));
});

// Raw SQL
const result = await db.execute(sql`EXEC sp_helpdb`);

// Cleanup
await db.close();
```

## Why not `child_process` + `tsql`?

|                | Old (tsql child_process)    | New (native db-lib)            |
| -------------- | --------------------------- | ------------------------------ |
| Connection     | New process + TCP per query | Persistent pooled connections  |
| Overhead       | Fork + exec + parse stdout  | Direct C function call         |
| Types          | Everything is a string      | int → number, bit → boolean    |
| Transactions   | Hack (batch in stdin)       | Real BEGIN/COMMIT on held conn |
| Prepared stmts | Impossible                  | Possible (future)              |
| Lambda         | Needs Layer for tsql binary | Self-contained in node_modules |

## Supported Platforms

| Platform | Architecture          | Binary                            |
| -------- | --------------------- | --------------------------------- |
| Linux    | ARM64 (Graviton)      | `sybase_native.linux-arm64.node`  |
| Linux    | x64                   | `sybase_native.linux-x64.node`    |
| macOS    | ARM64 (Apple Silicon) | `sybase_native.darwin-arm64.node` |
| macOS    | x64 (Intel)           | `sybase_native.darwin-x64.node`   |
| Windows  | x64                   | `sybase_native.win32-x64.node`    |

All platform binaries are bundled in the package. At runtime, only the binary matching your `process.platform` + `process.arch` is loaded via `dlopen`.

## Building from Source

If no prebuilt binary exists for your platform:

```bash
# Requires: C compiler, node-gyp, curl
bash scripts/build.sh
```

This will:

1. Download FreeTDS source
2. Compile as static library (`libsybdb.a`)
3. Build the N-API addon linked against it
4. Place the `.node` file in the correct `npm/` directory

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Your Application                                    │
│  db.select().from(users).where(eq(users.id, 1))    │
└──────────────────────────┬──────────────────────────┘
                           │ Drizzle API
┌──────────────────────────▼──────────────────────────┐
│  drizzle-sybase                                      │
│  - SybaseDialect (SQL generation)                    │
│  - Query Builders (SELECT/INSERT/UPDATE/DELETE)       │
│  - SybaseSession (execution + transactions)          │
│  - SybasePool (connection management)                │
└──────────────────────────┬──────────────────────────┘
                           │ N-API
┌──────────────────────────▼──────────────────────────┐
│  sybase_native.node (C addon)                        │
│  - connect() → dbopen()                              │
│  - query()   → dbcmd() + dbsqlexec() + dbresults()  │
│  - close()   → dbclose()                             │
│  - Async on libuv worker threads                     │
│  - FreeTDS libsybdb.a statically linked              │
└──────────────────────────┬──────────────────────────┘
                           │ TDS 5.0 (TCP)
                           ▼
              Sybase ASE Server (port 5000)
```

## Sybase SQL Dialect Notes

- **No LIMIT/OFFSET**: Uses `SET ROWCOUNT` for pagination
- **No RETURNING**: Uses `SELECT @@identity` after INSERT
- **No multi-row VALUES**: Each row is a separate INSERT statement
- **Identifiers**: Quoted with `[brackets]`
- **Date format**: `'YYYY-MM-DD HH:MM:SS.mmm'` (no T separator)

## License

MIT
