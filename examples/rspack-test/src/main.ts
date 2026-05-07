import { createSybaseDrizzle, sybaseTable, int, varchar } from "drizzle-sybase";
import { eq, sql } from "drizzle-orm";

// Define a schema
const sysobjects = sybaseTable("sysobjects", {
  name: varchar("name", { length: 255 }),
  type: varchar("type", { length: 10 }),
  id: int("id")
});

const main = async () => {
  console.log("=== Rspack + drizzle-sybase demo ===\n");

  const db = createSybaseDrizzle({
    host: process.env.SYBASE_HOST!,
    port: Number(process.env.SYBASE_PORT ),
    database: process.env.SYBASE_DATABASE!,
    username: process.env.SYBASE_USERNAME!,
    password: process.env.SYBASE_PASSWORD!,
    max: 3
  });

  // 1. Raw SQL
  console.log("1. Pool stats:", db.pool);
  const tables = await db.executeRaw(
    "SET ROWCOUNT 5\nSELECT name, type FROM sysobjects WHERE type = 'U' ORDER BY name\nSET ROWCOUNT 0"
  );
  console.log("   First 5 tables:", tables.rows);

  // 2. Template tag
  const count = await db.execute(
    sql`SELECT COUNT(*) AS total FROM sysobjects WHERE type = ${"U"}`
  );
  console.log("\n2. Total user tables:", count.rows[0].total);

  // 3. Transaction
  await db.transaction(async tx => {
    const r = await tx.executeRaw("SELECT @@version AS ver");
    console.log("\n3. Sybase version (in tx):", r.rows[0].ver);
  });

  // 4. Pool stats after queries
  console.log("\n4. Pool stats:", db.pool);

  await db.close();
  console.log("\n=== Done! rspack bundle works. ===");
};

main().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
