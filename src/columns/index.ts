/**
 * Sybase column types.
 *
 * Most columns are identical to MSSQL and are re-exported directly from
 * drizzle-orm/mssql-core. Sybase-specific types (money, smallmoney, image,
 * smalldatetime) are defined here via customType.
 */

// Re-export all MSSQL-compatible column types directly
export {
  int,
  bigint,
  smallint,
  tinyint,
  varchar,
  nvarchar,
  char,
  nchar,
  text,
  ntext,
  datetime,
  numeric,
  decimal,
  float,
  real,
  bit,
  binary,
  varbinary,
  customType
} from "drizzle-orm/mssql-core";

// Re-export column base types for advanced use
export type {
  MsSqlColumn as SybaseColumn,
  MsSqlColumnBuilder as SybaseColumnBuilder
} from "drizzle-orm/mssql-core";

// ---------------------------------------------------------------------------
// Sybase-specific column types (not in MSSQL core or need custom getSQLType)
// ---------------------------------------------------------------------------

import { customType } from "drizzle-orm/mssql-core";

/**
 * Sybase `smalldatetime` — datetime with minute precision.
 */
export const smalldatetime = customType<{ data: Date; driverParam: string }>({
  dataType() {
    return "smalldatetime";
  },
  fromDriver(value) {
    return new Date(value as string);
  },
  toDriver(value: Date) {
    // Sybase ASE does NOT accept ISO 8601 'T' separator — use space
    return value.toISOString().slice(0, 19).replace("T", " ");
  }
});

/**
 * Sybase `money` — fixed-point currency (8 bytes).
 */
export const money = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "money";
  }
});

/**
 * Sybase `smallmoney` — fixed-point currency (4 bytes).
 */
export const smallmoney = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "smallmoney";
  }
});

/**
 * Sybase `image` — binary large object (deprecated, but still used in legacy schemas).
 */
export const image = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "image";
  }
});
