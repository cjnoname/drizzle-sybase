/**
 * Auto-generated Sybase schema definitions.
 * Database: fixture
 * Generated: <fixture>
 *
 * DO NOT EDIT — re-run introspectSybase to regenerate.
 */

import { sybaseTable, int, bigint, smallint, tinyint, unsignedSmallint, unsignedInt, unsignedBigint, varchar, nvarchar, char, nchar, univarchar, unichar, text, unitext, datetime, smalldatetime, date, time, bigdatetime, bigtime, numeric, float, real, money, smallmoney, bit, binary, varbinary, image } from "drizzle-sybase";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════════
// Table Definitions
// ═══════════════════════════════════════════════════════════════════════════════

export const everyType = sybaseTable("EVERY_TYPE", {
  intNn: int("INT_NN").notNull(),
  intN: int("INT_N"),
  bigintNn: bigint("BIGINT_NN").notNull(),
  bigintN: bigint("BIGINT_N"),
  smallintNn: smallint("SMALLINT_NN").notNull(),
  smallintN: smallint("SMALLINT_N"),
  tinyintNn: tinyint("TINYINT_NN").notNull(),
  tinyintN: tinyint("TINYINT_N"),
  usmallintNn: unsignedSmallint("USMALLINT_NN").notNull(),
  usmallintN: unsignedSmallint("USMALLINT_N"),
  uintNn: unsignedInt("UINT_NN").notNull(),
  uintN: unsignedInt("UINT_N"),
  ubigintNn: unsignedBigint("UBIGINT_NN").notNull(),
  ubigintN: unsignedBigint("UBIGINT_N"),
  varcharNn: varchar("VARCHAR_NN", { length: 20 }).notNull(),
  varcharN: varchar("VARCHAR_N", { length: 20 }),
  nvarcharNn: nvarchar("NVARCHAR_NN", { length: 20 }).notNull(),
  nvarcharN: nvarchar("NVARCHAR_N", { length: 20 }),
  charNn: char("CHAR_NN", { length: 20 }).notNull(),
  charN: char("CHAR_N", { length: 20 }),
  ncharNn: nchar("NCHAR_NN", { length: 20 }).notNull(),
  ncharN: nchar("NCHAR_N", { length: 20 }),
  univarcharNn: univarchar("UNIVARCHAR_NN", { length: 10 }).notNull(),
  univarcharN: univarchar("UNIVARCHAR_N", { length: 10 }),
  unicharNn: unichar("UNICHAR_NN", { length: 10 }).notNull(),
  unicharN: unichar("UNICHAR_N", { length: 10 }),
  textNn: text("TEXT_NN").notNull(),
  textN: text("TEXT_N"),
  unitextNn: unitext("UNITEXT_NN").notNull(),
  unitextN: unitext("UNITEXT_N"),
  datetimeNn: datetime("DATETIME_NN").notNull(),
  datetimeN: datetime("DATETIME_N"),
  smalldatetimeNn: smalldatetime("SMALLDATETIME_NN").notNull(),
  smalldatetimeN: smalldatetime("SMALLDATETIME_N"),
  dateNn: date("DATE_NN").notNull(),
  dateN: date("DATE_N"),
  timeNn: time("TIME_NN").notNull(),
  timeN: time("TIME_N"),
  bigdatetimeNn: bigdatetime("BIGDATETIME_NN").notNull(),
  bigdatetimeN: bigdatetime("BIGDATETIME_N"),
  bigtimeNn: bigtime("BIGTIME_NN").notNull(),
  bigtimeN: bigtime("BIGTIME_N"),
  numericNn: numeric("NUMERIC_NN", { precision: 10, scale: 2 }).notNull(),
  numericN: numeric("NUMERIC_N", { precision: 10, scale: 2 }),
  decimalNn: numeric("DECIMAL_NN", { precision: 10, scale: 2 }).notNull(),
  decimalN: numeric("DECIMAL_N", { precision: 10, scale: 2 }),
  floatNn: float("FLOAT_NN").notNull(),
  floatN: float("FLOAT_N"),
  realNn: real("REAL_NN").notNull(),
  realN: real("REAL_N"),
  moneyNn: money("MONEY_NN").notNull(),
  moneyN: money("MONEY_N"),
  smallmoneyNn: smallmoney("SMALLMONEY_NN").notNull(),
  smallmoneyN: smallmoney("SMALLMONEY_N"),
  bitNn: bit("BIT_NN").notNull(),
  bitN: bit("BIT_N"),
  binaryNn: binary("BINARY_NN", { length: 20 }).notNull(),
  binaryN: binary("BINARY_N", { length: 20 }),
  varbinaryNn: varbinary("VARBINARY_NN", { length: 20 }).notNull(),
  varbinaryN: varbinary("VARBINARY_N", { length: 20 }),
  imageNn: image("IMAGE_NN").notNull(),
  imageN: image("IMAGE_N")
});


export const widths = sybaseTable("WIDTHS", {
  noWidth: numeric("NO_WIDTH").notNull(),
  exactInt: numeric("EXACT_INT", { precision: 15, scale: 0 }).notNull(),
  exactFrac: numeric("EXACT_FRAC", { precision: 15, scale: 4 }).notNull(),
  wideInt: numeric("WIDE_INT", { precision: 16, scale: 0 }).notNull(),
  wideFrac: numeric("WIDE_FRAC", { precision: 38, scale: 10 }).notNull()
});


export const defaults = sybaseTable("DEFAULTS", {
  id: int("ID").identity().notNull().primaryKey(),
  required: varchar("REQUIRED", { length: 10 }).notNull(),
  defaulted: datetime("DEFAULTED").notNull().hasDatabaseDefault(),
  nullableDefaulted: int("NULLABLE_DEFAULTED").hasDatabaseDefault(),
  optional: money("OPTIONAL")
});


// ═══════════════════════════════════════════════════════════════════════════════
// Indexes
// ═══════════════════════════════════════════════════════════════════════════════

export const defaultsIndexes = [
  { name: "pk_defaults", columns: ["ID"], primary: true, unique: true }
] as const;


// ═══════════════════════════════════════════════════════════════════════════════
// Zod Schemas (Select)
// ═══════════════════════════════════════════════════════════════════════════════

export const everyTypeSchema = z.object({
  intNn: z.number(),
  intN: z.number().nullable(),
  bigintNn: z.bigint(),
  bigintN: z.bigint().nullable(),
  smallintNn: z.number(),
  smallintN: z.number().nullable(),
  tinyintNn: z.number(),
  tinyintN: z.number().nullable(),
  usmallintNn: z.number(),
  usmallintN: z.number().nullable(),
  uintNn: z.number(),
  uintN: z.number().nullable(),
  ubigintNn: z.bigint(),
  ubigintN: z.bigint().nullable(),
  varcharNn: z.string().max(20),
  varcharN: z.string().max(20).nullable(),
  nvarcharNn: z.string().max(20),
  nvarcharN: z.string().max(20).nullable(),
  charNn: z.string().max(20),
  charN: z.string().max(20).nullable(),
  ncharNn: z.string().max(20),
  ncharN: z.string().max(20).nullable(),
  univarcharNn: z.string().max(10),
  univarcharN: z.string().max(10).nullable(),
  unicharNn: z.string().max(10),
  unicharN: z.string().max(10).nullable(),
  textNn: z.string(),
  textN: z.string().nullable(),
  unitextNn: z.instanceof(Buffer),
  unitextN: z.instanceof(Buffer).nullable(),
  datetimeNn: z.date(),
  datetimeN: z.date().nullable(),
  smalldatetimeNn: z.date(),
  smalldatetimeN: z.date().nullable(),
  dateNn: z.string(),
  dateN: z.string().nullable(),
  timeNn: z.string(),
  timeN: z.string().nullable(),
  bigdatetimeNn: z.string(),
  bigdatetimeN: z.string().nullable(),
  bigtimeNn: z.string(),
  bigtimeN: z.string().nullable(),
  numericNn: z.string(),
  numericN: z.string().nullable(),
  decimalNn: z.string(),
  decimalN: z.string().nullable(),
  floatNn: z.number(),
  floatN: z.number().nullable(),
  realNn: z.number(),
  realN: z.number().nullable(),
  moneyNn: z.string(),
  moneyN: z.string().nullable(),
  smallmoneyNn: z.string(),
  smallmoneyN: z.string().nullable(),
  bitNn: z.boolean(),
  bitN: z.boolean().nullable(),
  binaryNn: z.instanceof(Buffer),
  binaryN: z.instanceof(Buffer).nullable(),
  varbinaryNn: z.instanceof(Buffer),
  varbinaryN: z.instanceof(Buffer).nullable(),
  imageNn: z.instanceof(Buffer),
  imageN: z.instanceof(Buffer).nullable()
});
export type EveryTypeRow = z.infer<typeof everyTypeSchema>;


export const widthsSchema = z.object({
  noWidth: z.string(),
  exactInt: z.string(),
  exactFrac: z.string(),
  wideInt: z.string(),
  wideFrac: z.string()
});
export type WidthsRow = z.infer<typeof widthsSchema>;


export const defaultsSchema = z.object({
  id: z.number(),
  required: z.string().max(10),
  defaulted: z.date(),
  nullableDefaulted: z.number().nullable(),
  optional: z.string().nullable()
});
export type DefaultsRow = z.infer<typeof defaultsSchema>;


// ═══════════════════════════════════════════════════════════════════════════════
// Zod Schemas (Insert)
// ═══════════════════════════════════════════════════════════════════════════════

/** A plain integer literal — the string form an exact numeric column accepts. */
const integerLiteral = z.string().regex(/^[+-]?\d+$/, "expected an integer");

/** A plain decimal literal — the string form an exact numeric column accepts. */
const decimalLiteral = z.string().regex(
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/,
  "expected a decimal number"
);

export const everyTypeInsertSchema = z.object({
  intNn: z.number(),
  intN: z.number().nullable().optional(),
  bigintNn: z.union([z.bigint(), integerLiteral]),
  bigintN: z.union([z.bigint(), integerLiteral]).nullable().optional(),
  smallintNn: z.number(),
  smallintN: z.number().nullable().optional(),
  tinyintNn: z.number(),
  tinyintN: z.number().nullable().optional(),
  usmallintNn: z.number(),
  usmallintN: z.number().nullable().optional(),
  uintNn: z.number(),
  uintN: z.number().nullable().optional(),
  ubigintNn: z.union([z.bigint(), integerLiteral]),
  ubigintN: z.union([z.bigint(), integerLiteral]).nullable().optional(),
  varcharNn: z.string().max(20),
  varcharN: z.string().max(20).nullable().optional(),
  nvarcharNn: z.string().max(20),
  nvarcharN: z.string().max(20).nullable().optional(),
  charNn: z.string().max(20),
  charN: z.string().max(20).nullable().optional(),
  ncharNn: z.string().max(20),
  ncharN: z.string().max(20).nullable().optional(),
  univarcharNn: z.string().max(10),
  univarcharN: z.string().max(10).nullable().optional(),
  unicharNn: z.string().max(10),
  unicharN: z.string().max(10).nullable().optional(),
  textNn: z.string(),
  textN: z.string().nullable().optional(),
  unitextNn: z.instanceof(Buffer),
  unitextN: z.instanceof(Buffer).nullable().optional(),
  datetimeNn: z.date(),
  datetimeN: z.date().nullable().optional(),
  smalldatetimeNn: z.date(),
  smalldatetimeN: z.date().nullable().optional(),
  dateNn: z.string(),
  dateN: z.string().nullable().optional(),
  timeNn: z.string(),
  timeN: z.string().nullable().optional(),
  bigdatetimeNn: z.string(),
  bigdatetimeN: z.string().nullable().optional(),
  bigtimeNn: z.string(),
  bigtimeN: z.string().nullable().optional(),
  numericNn: z.union([z.number(), decimalLiteral]),
  numericN: z.union([z.number(), decimalLiteral]).nullable().optional(),
  decimalNn: z.union([z.number(), decimalLiteral]),
  decimalN: z.union([z.number(), decimalLiteral]).nullable().optional(),
  floatNn: z.number(),
  floatN: z.number().nullable().optional(),
  realNn: z.number(),
  realN: z.number().nullable().optional(),
  moneyNn: decimalLiteral,
  moneyN: decimalLiteral.nullable().optional(),
  smallmoneyNn: z.union([z.number(), decimalLiteral]),
  smallmoneyN: z.union([z.number(), decimalLiteral]).nullable().optional(),
  bitNn: z.boolean(),
  bitN: z.boolean().nullable().optional(),
  binaryNn: z.instanceof(Buffer),
  binaryN: z.instanceof(Buffer).nullable().optional(),
  varbinaryNn: z.instanceof(Buffer),
  varbinaryN: z.instanceof(Buffer).nullable().optional(),
  imageNn: z.instanceof(Buffer),
  imageN: z.instanceof(Buffer).nullable().optional()
});
export type NewEveryType = z.infer<typeof everyTypeInsertSchema>;


export const widthsInsertSchema = z.object({
  noWidth: decimalLiteral,
  exactInt: z.union([z.number().int(), integerLiteral]),
  exactFrac: z.union([z.number(), decimalLiteral]),
  wideInt: z.union([z.bigint(), integerLiteral]),
  wideFrac: decimalLiteral
});
export type NewWidths = z.infer<typeof widthsInsertSchema>;


export const defaultsInsertSchema = z.object({
  required: z.string().max(10),
  defaulted: z.date().optional(),
  nullableDefaulted: z.number().nullable().optional(),
  optional: decimalLiteral.nullable().optional()
});
export type NewDefaults = z.infer<typeof defaultsInsertSchema>;

