# drizzle-sybase

[![npm version](https://img.shields.io/npm/v/drizzle-sybase.svg)](https://www.npmjs.com/package/drizzle-sybase)
[![npm downloads](https://img.shields.io/npm/dm/drizzle-sybase.svg)](https://www.npmjs.com/package/drizzle-sybase)
[![license](https://img.shields.io/npm/l/drizzle-sybase.svg)](https://github.com/cjnoname/drizzle-sybase/blob/main/LICENSE)

Drizzle ORM driver for **Sybase ASE** with built-in FreeTDS native bindings.

Zero system dependencies — FreeTDS is statically compiled into the native addon. Works on Lambda (ARM64/x64), containers, and local dev without installing anything.

## Install

```bash
npm install drizzle-sybase
# All platform binaries are included — only the matching one is loaded at runtime
```

## Usage

```ts
import { eq, sql } from "drizzle-orm";
import { createSybaseDrizzle, sybaseTable, int, varchar, datetime } from "drizzle-sybase";

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

// SELECT — rows are keyed by property name ({ id, name, email, createdAt })
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

## Type Inference

Row and insert types are inferred from the table definition, matching exactly
what the driver returns at runtime:

```ts
type User = typeof users.$inferSelect; // or InferSelectModel<typeof users>
// { id: number; name: string; email: string | null; createdAt: Date | null }

type NewUser = typeof users.$inferInsert; // or InferInsertModel<typeof users>
// { name: string; email?: string | null; createdAt?: Date | null }
```

- **Nullability**: a column is `T | null` unless it is `.notNull()` (or a primary key).
- **Insert**: a column is required only if it is not null and nothing else fills it. Optional are columns with `.default(value)` or `.hasDatabaseDefault()` — both declare a database `DEFAULT`, as `.default()` does in drizzle: the driver omits the column and the server fills it, `value` itself is never sent — and columns with `.$defaultFn()` / `.$onUpdateFn()`, which the driver computes. Identity columns are not accepted at all; the server assigns them.
- **Select results** follow the query. `db.select()` returns the table row; `db.select({ ... })` returns one key per field — a `sql<number>` expression is a `number`, a raw string expression `unknown`. A `leftJoin` makes the joined table's columns nullable, a `rightJoin` every earlier table's. A table given by name (`from("#tmp")`) is untyped.
- **Clashing joins** do not compile: with no fields, every column lands in one flat row, so joining two tables that share a property name is a type error naming the property. Pass the fields explicitly instead.
- **Use the returned builder.** Builders change in place (as in drizzle), but only the value a method returns carries the updated type: chain the calls, or keep the result (`const joined = q.leftJoin(...)`) — a bare `q.leftJoin(...)` leaves `q` typed as before.
- **Narrowing**: `.$type<"active" | "disabled">()` narrows a column's value type.

| SQL type                                                                           | Read as   | Accepted on write                                                                            |
| ---------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `int`, `smallint`, `tinyint`, `unsigned smallint`, `unsigned int`, `float`, `real` | `number`  | `number`                                                                                     |
| `bigint`, `unsigned bigint`                                                        | `bigint`  | `bigint` or a digit string                                                                   |
| `numeric`/`decimal`, `money`, `smallmoney`                                         | `string`  | a digit string; also a `number` if precision ≤ 15, a `bigint` if a wider integer (see below) |
| `bit`                                                                              | `boolean` | `boolean`                                                                                    |
| `datetime`, `smalldatetime`                                                        | `Date`    | `Date`                                                                                       |
| `date`, `time`, `bigdatetime`, `bigtime`                                           | `string`  | `string` (see [Date and Time Columns](#date-and-time-columns))                               |
| `char`, `varchar`, `nchar`, `nvarchar`, `unichar`, `univarchar`, `text`            | `string`  | `string`                                                                                     |
| `binary`, `varbinary`, `image`                                                     | `Buffer`  | `Buffer`                                                                                     |
| `unitext`                                                                          | `Buffer`  | `Buffer` — UTF-16LE: `Buffer.from(s, "utf16le")` / `buf.toString("utf16le")`                 |

`unitext` is bytes because db-lib receives it as an image: there is no way to tell
it apart in a result, and a string literal written to it goes through the server
charset and loses what that cannot represent. UTF-16LE bytes round-trip exactly.
`ntext()` is deprecated — ASE has no such type.

Every insert/update value may also be a SQL expression, e.g. `` sql`getdate()` ``.

Comparison operators come from `drizzle-orm` and do not check the compared
value against the column type: `eq(users.id, "x")` compiles.

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
4. Place the `.node` file in `src/native/` (e.g. `sybase_native.darwin-arm64.node`)

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

- **No LIMIT/OFFSET**: `limit()` is `SELECT TOP n` (offsets fetch `offset + limit` rows and skip the first `offset`); `limit()`/`offset()` take non-negative integers only. TOP, unlike `SET ROWCOUNT`, leaves nothing set on the connection
- **No RETURNING**: Uses `SELECT @@identity` after INSERT
- **No multi-row VALUES**: Each row is a separate INSERT statement; a multi-row insert runs all-or-nothing (in its own transaction, or under a savepoint inside `db.transaction`), so its locks are held until the last row is written
- **No CTEs (`WITH`) and no `FULL OUTER JOIN`**: ASE supports neither; use derived tables / `UNION` of left and right joins
- **Server-aborted transactions**: ASE rolls a transaction back on its own after some errors (conversion, divide-by-zero, deadlock). Once that happens the `tx` handle refuses further statements and `db.transaction` rejects instead of committing
- **Raw multi-statement batches are not atomic**: after a statement-level error (e.g. a duplicate key) ASE carries on with the rest of the batch, so earlier and later statements may already be applied when the error is reported. Run such batches inside `db.transaction()` if they must be all-or-nothing
- **Session state does not leak between pool users**: a connection always returns to the pool with no open transaction, `ROWCOUNT 0`, chained mode off, its original isolation level and the configured database. A raw statement outside `db.transaction()` that leaves a transaction open is rolled back and reported as an error — use `db.transaction()` instead. A connection that ran `setuser` is discarded rather than reused, since its original identity cannot be restored reliably. Other `SET` options (`dateformat`, `textsize`, ...) are not reset
- **Inside `db.transaction()`, the callback must not end the transaction itself**: a batch containing `COMMIT` or a `ROLLBACK` without a savepoint name is refused before it is sent — once it ran, the rest of its batch would run in autocommit. A procedure that commits or rolls back cannot be seen in the SQL: the driver detects it after the call and refuses every later statement (what the procedure committed stays committed). Savepoints (`save tran x` / `rollback tran x`) are fine
- **Results are capped at 1,000,000 rows**: a larger result fails rather than being silently cut short. Pass `maxRows` to accept a truncated result
- **Packet size**: `packetSize` defaults to 2048, ASE's out-of-the-box `max network packet size`. A server whose limit was raised (e.g. to 4096) can take a larger value for fewer round-trips on big results; one whose limit was lowered (it can go down to 512) needs a smaller one. A request above the server's limit is refused with the same "Login failed" (Msg 4002) as a wrong password — the error message points this out
- **Temporary tables do not outlive their query or transaction**: a `#temp` table created by a pool query is dropped when that query finishes (the next one may run on another connection), and one created inside `db.transaction()` is dropped when the transaction ends. To use one across several statements, run them in `db.withConnection(async conn => ...)`: one connection, no transaction, and its `#temp` tables are dropped when the callback returns. (Inside `db.transaction()` ASE only allows creating them when `ddl in tran` is enabled.)
- **Identifiers**: Quoted with `[brackets]`
- **Date format**: `'YYYY-MM-DD HH:MM:SS.mmm'` (no T separator)

## Exact Numeric Types

`money`, `smallmoney`, `bigint` and `numeric`/`decimal` hold more significant
digits than a JS double (money alone needs 19), so the driver never routes them
through one:

| Sybase type                                | Read as                | Accepts on write                                                  |
| ------------------------------------------ | ---------------------- | ----------------------------------------------------------------- |
| `money`, `smallmoney`, `numeric`/`decimal` | string (digits intact) | string → `convert(<type>, '...')`, number/`BigInt` → bare literal |
| `bigint`                                   | `BigInt`               | `BigInt`/number → bare literal, string → `convert(bigint, '...')` |
| `int`, `smallint`, `tinyint`               | number                 | bare literal                                                      |
| `float`, `real`                            | number                 | bare literal                                                      |

ASE refuses a quoted literal against these types (`Msg 257: Implicit conversion
from datatype 'VARCHAR' to 'MONEY' is not allowed`), so a decimal string bound to
one is wrapped in `CONVERT` — in `values()`, `set()` and in `where` / `join ... on`
/ `having` alike. The value stays quoted and escaped, so this is not an injection
vector, and `CONVERT` parses the digits server-side at full precision, so nothing
is lost.

Two cases are deliberately **not** wrapped, so that they fail loudly rather than
lose digits:

- **A literal with more fraction digits than the target keeps.** `'1.5'` against
  `bigint`, or `'1.234'` against `numeric(10,2)`, stays a plain string and ASE
  rejects it with Msg 257. Converting it would silently round instead.
- **`numeric`/`decimal` declared without a precision.** ASE defaults a bare
  `numeric` to `(18,0)`, which would round every fraction away, so
  `numeric("col")` never gets a `CONVERT`. Declare the width the column actually
  has — `numeric("col", { precision: 19, scale: 4 })` — and it works. Introspected
  schemas always carry the width, so this only affects hand-written ones.

`insertId` after an `INSERT` follows the same rule. `@@identity` is
`numeric(38,0)`, so an identity past 2^53 has no exact `number`; `insertId` is
`undefined` in that case and `insertIdText` carries the digits, which is always
populated when the table has an identity column.

### Serializing rows that contain a `bigint`

`bigint` columns come back as `BigInt`, which `JSON.stringify` refuses to
serialize. Nothing in the type system catches this, so anywhere a row reaches
JSON — an API response, a log line, a cache write — needs a replacer:

```ts
JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? v.toString() : v));
```

### Arbitrary-precision arithmetic

The driver deliberately does none, and needs no decimal library: exact numerics
cross the wire as digit strings and `CONVERT` has ASE parse them server-side at
full precision. If you need to _compute_ with them, do it in your own code with
whichever library you already use, and hand back a plain decimal string:

```ts
import Decimal from "decimal.js";

const total = new Decimal(row.totPrRoyalty).plus("0.0001");
await db.update(winf).set({ totPrRoyalty: total.toFixed(4) }).where(...);
```

`$mapToDriver` can do that last step per column. There is no `$mapFromDriver`:
results are decoded from the type metadata the addon reports, and at that point
the query's schema is no longer available — `db.select().from("NAME")` returns `*`, joined
columns can share a name, and an aggregate belongs to no column. Converting on
read is a line at the use site instead.

A bare value interpolated into a raw `sql` template carries no column, so nothing
can be inferred for it. Bind it explicitly when the target is an exact numeric:

```ts
// Rejected by ASE — the literal is a plain string
await db.execute(sql`select * from WINF where tot_pr_royalty = ${"1.5000"}`);

// Converted, because the parameter knows its column
await db.execute(
  sql`select * from WINF where tot_pr_royalty = ${sql.param("1.5000", winf.totPrRoyalty)}`
);
```

## Date and Time Columns

`datetime` and `smalldatetime` are always returned as `Date`, and `Date` values
are always written as `'YYYY-MM-DD HH:MM:SS.mmm'`. The type never varies with
configuration, so a row is never sometimes a `Date` and sometimes a string.

These columns store a naive wall clock — no offset, no zone — so `timeZone` says
which zone that wall clock belongs to. It applies to both directions and defaults
to `UTC`:

```ts
const db = createSybaseDrizzle({
  /* ... */
  timeZone: "Australia/Sydney"
});
```

An invalid zone is rejected when the connection is created, not on the first
query. Leaving `timeZone` unset makes reads and writes exact inverses in UTC,
which is correct as long as nothing else interprets the stored values; set it when
the stored wall clocks are meant to be a particular zone's local time.

**Set it to the zone the server's clock is in.** Values written by the server
itself (`getdate()`, column defaults, other applications) are in that zone, and
reading them as another would shift every one by the difference. When a
connection opens, the driver compares the server's offset (`getdate()` against
`getutcdate()`) with `timeZone`'s and, if they differ, emits a process warning
with code `DRIZZLE_SYBASE_TIMEZONE`, once per server, database and zone.

A stored wall clock cannot always be mapped to one instant, because the column
holds no offset. Both cases follow `Temporal`'s `compatible` disambiguation,
which is also what `new Date("YYYY-MM-DDTHH:mm")` does with the process zone:

- **A wall clock a backward transition repeats** matches two instants. The
  **earlier** one is returned.
- **A wall clock a forward transition skips** matches none. It is moved forward
  by the size of the jump — what the zone's clocks did. Only reachable for values
  written by something other than this driver, since the driver never writes a
  wall clock that does not exist.

A `Date` outside what an ASE `datetime` can hold — before 1753-01-01 or after
9999-12-31 **on the server's clock** — is rejected before the statement is built,
rather than sent as a literal ASE answers with an arithmetic-overflow error that
names neither the column nor the value.

`date`, `time`, `bigdatetime` and `bigtime` are returned as canonical text
(`2016-06-09`, `09:48:46.753`, `2016-06-09 09:48:46.753456`) rather than `Date`: a
bare date or time is not an instant, and `bigdatetime`/`bigtime` carry microseconds
that a `Date` would silently truncate.

All of these are formatted by the native addon from the raw value, not by db-lib's
text conversion. db-lib formats through a locale-dependent format string, which in
several common locales drops the seconds and milliseconds entirely — under
`LANG=it_IT.UTF-8` the same value comes out as `09/06/2016 09:48`.

## Schema Introspection (generate schema from an existing database)

Reverse-engineer Sybase ASE tables into drizzle-sybase definitions, Zod
schemas, and TypeScript types — the Sybase equivalent of `drizzle-kit pull`.

The generated file imports `zod`, which this package does not depend on:
install it in the project that uses the generated code (`npm i zod`; the output
is checked against Zod 4). The `<Table>Row` / `New<Table>` types it exports are
identical to `typeof table.$inferSelect` / `$inferInsert`.

`nchar`/`nvarchar` lengths are read in characters using the server's own
`@@ncharsize`, so they are right on single-byte server charsets too.

### CLI

```bash
npx drizzle-sybase-introspect \
  --host=sybase-host --port=5000 --database=mydb \
  --username=sa --password=secret \
  --tables=USERS,ORDERS --owner=dbo \
  --out=src/drizzle/generated/sybase.ts
```

Credentials can also be supplied via env vars: `SYBASE_HOST`, `SYBASE_PORT`,
`SYBASE_DATABASE`, `SYBASE_USERNAME`, `SYBASE_PASSWORD`, `SYBASE_TABLES`.
Omit `--out` to print to stdout, and omit `--tables` to introspect all user tables.

### Programmatic

```ts
import { writeFileSync } from "node:fs";

import { introspectSybase, introspectWith } from "drizzle-sybase/introspect";

// Self-contained: opens a short-lived pool and closes it.
const { code, warnings } = await introspectSybase({
  host: "sybase-host",
  port: 5000,
  database: "mydb",
  username: "sa",
  password: "secret",
  tables: ["USERS", "ORDERS"]
});
warnings.forEach(w => console.warn(w));
writeFileSync("src/drizzle/generated/sybase.ts", code);

// Or reuse an existing db/pool (e.g. credentials from a secrets manager):
const db = createSybaseDrizzle({/* ... */});
const result = await introspectWith(db, { database: "mydb", tables: ["USERS"] });
```

The generator reads the Sybase system catalogs (`sysobjects`, `syscolumns`,
`systypes`, `syscomments`, `sysindexes`), resolves user-defined types back to
their base system type, halves byte lengths for national (Unicode) char types,
and emits:

- `sybaseTable(...)` definitions (single-column primary keys inline; composite
  keys preserved as a comment and in the exported `<table>Indexes` constant)
- `<table>Indexes` metadata (primary/unique flags + key columns)
- Zod select schemas (`<table>Schema` + `<Table>Row` type)
- Zod insert schemas (`<table>InsertSchema` + `New<Table>` type, identity columns excluded)

The two are not mirror images. `<Table>Row` describes what the driver actually
returns, so exact numerics are `z.string()` (digits intact) and `bigint` is
`z.bigint()`; it never coerces, because a coercion there would only paper over a
row type that disagrees with reality.

The insert schema accepts every type the column can hold **without losing
digits**, and no others:

| Column width                       | Insert accepts                                   |
| ---------------------------------- | ------------------------------------------------ |
| scale 0, precision ≤ 15            | `number` (integer) or an integer string          |
| scale > 0, precision ≤ 15          | `number` or a decimal string                     |
| scale 0, precision > 15 (`bigint`) | `BigInt` or an integer string — **not** `number` |
| scale > 0, precision > 15          | a decimal string only                            |

A plain `number` is refused for integers wider than a double on purpose:
`9007199254740993` has already become `...992` before any validator sees it, so
`z.coerce.bigint()` would report success on a value that had silently lost a
digit. The string forms are constrained to plain digit literals, which is exactly
what the dialect can write — anything else would reach ASE as a quoted value and
come back as Msg 257, so it fails validation instead.

Unmapped Sybase types fall back to `varchar` and are reported via `warnings`.

## License

MIT
