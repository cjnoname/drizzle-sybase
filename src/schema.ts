/**
 * Zod schema generation for Sybase tables.
 *
 * Since Sybase tables use the mssql-core infrastructure, we can leverage
 * drizzle-orm's built-in zod integration.
 */
export { createSelectSchema, createInsertSchema, createUpdateSchema } from "drizzle-orm/zod";
