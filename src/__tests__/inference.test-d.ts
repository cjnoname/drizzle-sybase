/**
 * Type-level tests for schema and query inference.
 *
 * Checked by `tsc` (`npm run type`), not run by vitest: every assertion here is
 * a compile-time one. A wrong inference, or an `@ts-expect-error` that no longer
 * finds an error, fails the type check.
 */
import { eq, getColumns, getTableColumns, getTableName, is, sql, Table } from "drizzle-orm";
import { describe, expectTypeOf, it } from "vitest";

import {
  bigdatetime,
  bigint,
  bigtime,
  binary,
  bit,
  char,
  date,
  datetime,
  decimal,
  float,
  image,
  int,
  money,
  nchar,
  ntext,
  numeric,
  nvarchar,
  real,
  smalldatetime,
  smallint,
  smallmoney,
  text,
  time,
  tinyint,
  unichar,
  unitext,
  univarchar,
  unsignedBigint,
  unsignedInt,
  unsignedSmallint,
  varbinary,
  varchar
} from "../columns/index.js";
import { createSybaseDrizzle } from "../db.js";
import { sybaseTable, type InferInsertModel, type InferSelectModel } from "../table.js";

const db = createSybaseDrizzle({ host: "h", port: 1, database: "d", username: "u", password: "p" });

const allTypes = sybaseTable("all_types", {
  i: int("i").notNull(),
  si: smallint("si").notNull(),
  ti: tinyint("ti").notNull(),
  bi: bigint("bi").notNull(),
  f: float("f").notNull(),
  r: real("r").notNull(),
  vc: varchar("vc", { length: 10 }).notNull(),
  nvc: nvarchar("nvc", { length: 10 }).notNull(),
  c: char("c", { length: 2 }).notNull(),
  nc: nchar("nc", { length: 2 }).notNull(),
  t: text("t").notNull(),
  nt: ntext("nt").notNull(),
  dt: datetime("dt").notNull(),
  sdt: smalldatetime("sdt").notNull(),
  m: money("m").notNull(),
  sm: smallmoney("sm").notNull(),
  b: bit("b").notNull(),
  bin: binary("bin", { length: 4 }).notNull(),
  vbin: varbinary("vbin", { length: 4 }).notNull(),
  img: image("img").notNull(),
  us: unsignedSmallint("us").notNull(),
  ui: unsignedInt("ui").notNull(),
  ub: unsignedBigint("ub").notNull(),
  uc: unichar("uc", { length: 2 }).notNull(),
  uvc: univarchar("uvc", { length: 10 }).notNull(),
  ut: unitext("ut").notNull(),
  d: date("d").notNull(),
  tm: time("tm").notNull(),
  bdt: bigdatetime("bdt").notNull(),
  bt: bigtime("bt").notNull(),
  // Fixed-point widths, by the same rule as the generated Zod schemas.
  nNoWidth: numeric("n_no_width").notNull(),
  nInt: numeric("n_int", { precision: 9, scale: 0 }).notNull(),
  nFrac: decimal("n_frac", { precision: 15, scale: 2 }).notNull(),
  nWideInt: numeric("n_wide_int", { precision: 30 }).notNull(),
  nWideFrac: numeric("n_wide_frac", { precision: 16, scale: 1 }).notNull()
});

describe("column read types mirror the native decoding", () => {
  it("selects every type as binding.c decodes it", () => {
    expectTypeOf<InferSelectModel<typeof allTypes>>().toEqualTypeOf<{
      i: number;
      si: number;
      ti: number;
      bi: bigint;
      f: number;
      r: number;
      vc: string;
      nvc: string;
      c: string;
      nc: string;
      t: string;
      nt: string;
      dt: Date;
      sdt: Date;
      m: string;
      sm: string;
      b: boolean;
      bin: Buffer;
      vbin: Buffer;
      img: Buffer;
      us: number;
      ui: number;
      ub: bigint;
      uc: string;
      uvc: string;
      ut: Buffer;
      d: string;
      tm: string;
      bdt: string;
      bt: string;
      nNoWidth: string;
      nInt: string;
      nFrac: string;
      nWideInt: string;
      nWideFrac: string;
    }>();
  });

  it("writes exact numerics only from values they hold without losing digits", () => {
    type Insert = InferInsertModel<typeof allTypes>;
    expectTypeOf<Insert["bi"]>().toEqualTypeOf<bigint | string>();
    expectTypeOf<Insert["ub"]>().toEqualTypeOf<bigint | string>();
    expectTypeOf<Insert["ut"]>().toEqualTypeOf<Buffer>();
    expectTypeOf<Insert["m"]>().toEqualTypeOf<string>();
    expectTypeOf<Insert["sm"]>().toEqualTypeOf<number | string>();
    expectTypeOf<Insert["nNoWidth"]>().toEqualTypeOf<string>();
    expectTypeOf<Insert["nInt"]>().toEqualTypeOf<number | string>();
    expectTypeOf<Insert["nFrac"]>().toEqualTypeOf<number | string>();
    expectTypeOf<Insert["nWideInt"]>().toEqualTypeOf<bigint | string>();
    expectTypeOf<Insert["nWideFrac"]>().toEqualTypeOf<string>();
  });
});

const users = sybaseTable("users", {
  id: int("id").primaryKey().identity(),
  name: varchar("name", { length: 50 }).notNull(),
  email: varchar("email", { length: 100 }),
  status: varchar("status", { length: 10 }).notNull().$type<"active" | "disabled">(),
  createdAt: datetime("created_at").notNull().hasDatabaseDefault(),
  updatedAt: datetime("updated_at")
    .notNull()
    .$onUpdateFn(() => new Date()),
  score: int("score").notNull().default(0)
});

const orders = sybaseTable("orders", {
  orderId: int("order_id").primaryKey().identity(),
  userId: int("user_id").notNull(),
  total: money("total").notNull(),
  note: varchar("note", { length: 100 })
});

describe("table models", () => {
  it("infers the select model", () => {
    expectTypeOf(users.$inferSelect).toEqualTypeOf<{
      id: number;
      name: string;
      email: string | null;
      status: "active" | "disabled";
      createdAt: Date;
      updatedAt: Date;
      score: number;
    }>();
  });

  it("requires only not-null columns nothing else fills, and omits identities", () => {
    expectTypeOf(users.$inferInsert).toEqualTypeOf<{
      name: string;
      status: "active" | "disabled";
      email?: string | null;
      createdAt?: Date;
      updatedAt?: Date;
      score?: number;
    }>();
  });

  it("types the built columns", () => {
    expectTypeOf(users.name.getSQL()).toEqualTypeOf<ReturnType<typeof sql<string>>>();
    expectTypeOf(users.email.getSQL()).toEqualTypeOf<ReturnType<typeof sql<string | null>>>();
  });
});

describe("drizzle's own helpers accept Sybase tables", () => {
  it("getTableName returns the table's name", () => {
    expectTypeOf(getTableName(users)).toEqualTypeOf<"users">();
    const owned = sybaseTable("t", { a: int("a") }, { owner: "x" });
    expectTypeOf(getTableName(owned)).toEqualTypeOf<"t">();
  });

  it("getColumns / getTableColumns give columns a select and mapToDriverValue accept", async () => {
    const columns = getColumns(users);
    columns.createdAt.mapToDriverValue(new Date());
    getTableColumns(users);
    const rows = await db.select(getColumns(users)).from(users).where(eq(users.id, 1));
    // drizzle types them as its general column, so the values are unknown.
    expectTypeOf(rows).toEqualTypeOf<Record<string, unknown>[]>();
  });

  it("col.as() keeps the column's type", async () => {
    expectTypeOf(users.name.as("n")).toEqualTypeOf(users.name);
    const rows = await db.select({ n: users.email.as("n") }).from(users);
    expectTypeOf(rows).toEqualTypeOf<{ n: string | null }[]>();
  });

  it("is() narrows to a drizzle Table", () => {
    const value: unknown = users;
    if (is(value, Table)) {
      expectTypeOf(value).toEqualTypeOf<Table>();
    }
  });
});

describe("insert", () => {
  it("accepts a valid row, a list, and SQL values", () => {
    db.insert(users).values({ name: "a", status: "active" });
    db.insert(users).values([
      { name: "a", status: "active", email: null },
      { name: "b", status: "disabled", createdAt: sql`getdate()` }
    ]);
  });

  it("rejects missing, unknown, mistyped and identity columns", () => {
    // @ts-expect-error -- name is required
    db.insert(users).values({ status: "active" });
    // @ts-expect-error -- no such column
    db.insert(users).values({ name: "a", status: "active", nope: 1 });
    // @ts-expect-error -- not a status
    db.insert(users).values({ name: "a", status: "gone" });
    // @ts-expect-error -- not null
    db.insert(users).values({ name: null, status: "active" });
    // @ts-expect-error -- identity is assigned by the server
    db.insert(users).values({ id: 1, name: "a", status: "active" });
    // @ts-expect-error -- money is wider than a double: a number would lose digits
    db.insert(orders).values({ userId: 1, total: 1.5 });
  });
});

describe("update", () => {
  it("accepts any subset of writable columns", () => {
    db.update(users).set({ email: null });
    db.update(users).set({ name: "b", score: sql`[score] + 1` });
  });

  it("rejects identity, unknown and null-into-not-null", () => {
    // @ts-expect-error -- identity cannot be updated
    db.update(users).set({ id: 2 });
    // @ts-expect-error -- no such column
    db.update(users).set({ nope: 1 });
    // @ts-expect-error -- not null
    db.update(users).set({ name: null });
  });
});

type Row<Q> = Q extends PromiseLike<(infer R)[]> ? R : never;

describe("select", () => {
  it("returns the table row with no fields", () => {
    const q = db.select().from(users).where(eq(users.id, 1)).orderBy(users.name).limit(5);
    expectTypeOf<Row<typeof q>>().toEqualTypeOf(users.$inferSelect);
  });

  it("returns each field's value", () => {
    const q = db
      .select({
        id: users.id,
        email: users.email,
        n: sql<number>`count(*)`,
        label: sql<string>`upper([name])`.as("label"),
        raw: "getdate()"
      })
      .from(users)
      .groupBy(users.id, users.email);
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<{
      id: number;
      email: string | null;
      n: number;
      label: string;
      raw: unknown;
    }>();
  });

  it("makes the joined table nullable on a left join", () => {
    const q = db
      .select({ name: users.name, total: orders.total })
      .from(users)
      .leftJoin(orders, eq(users.id, orders.userId));
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<{ name: string; total: string | null }>();

    const all = db.select().from(users).leftJoin(orders, eq(users.id, orders.userId));
    expectTypeOf<Row<typeof all>["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Row<typeof all>["orderId"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Row<typeof all>["note"]>().toEqualTypeOf<string | null>();
  });

  it("makes every earlier table nullable on a right join", () => {
    const q = db
      .select({ name: users.name, total: orders.total })
      .from(users)
      .rightJoin(orders, eq(users.id, orders.userId));
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<{ name: string | null; total: string }>();
  });

  it("keeps both sides of an inner join as declared", () => {
    const q = db
      .select({ name: users.name, total: orders.total })
      .from(users)
      .innerJoin(orders, eq(users.id, orders.userId));
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<{ name: string; total: string }>();
  });

  it("rejects a join whose properties clash, as the builder would at runtime", () => {
    const dup = sybaseTable("dup", { name: varchar("name", { length: 5 }) });
    db.select()
      .from(users)
      // @ts-expect-error -- "name" exists in both tables
      .innerJoin(dup, sql`1 = 1`);
    // Explicit fields name every key, so the same join is fine.
    const q = db
      .select({ a: users.name, b: dup.name })
      .from(users)
      .innerJoin(dup, sql`1 = 1`);
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<{ a: string; b: string | null }>();
    // So is a table given by name, which is selected with `*`.
    db.select()
      .from("#tmp")
      .innerJoin(dup, sql`1 = 1`);
  });

  it("tells same-named tables of different owners apart", () => {
    const a = sybaseTable("t", { a: int("a").notNull() }, { owner: "x" });
    const b = sybaseTable("t", { b: int("b").notNull() }, { owner: "y" });
    const q = db
      .select({ a: a.a, b: b.b })
      .from(a)
      .leftJoin(b, sql`1 = 1`);
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<{ a: number; b: number | null }>();
  });

  it("makes earlier tables nullable on a right join to a table given by name", () => {
    const q = db
      .select({ name: users.name })
      .from(users)
      .rightJoin("#tmp", sql`1 = 1`);
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<{ name: string | null }>();
  });

  it("leaves a table given by name untyped", () => {
    const q = db.select().from("#tmp");
    expectTypeOf<Row<typeof q>>().toEqualTypeOf<Record<string, unknown>>();
  });

  it("types the same way inside a transaction", async () => {
    await db.transaction(async tx => {
      const q = tx.select({ id: users.id }).from(users);
      expectTypeOf<Row<typeof q>>().toEqualTypeOf<{ id: number }>();
      // @ts-expect-error -- name is required
      tx.insert(users).values({ status: "active" });
    });
  });
});
