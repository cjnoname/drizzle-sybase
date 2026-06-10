/**
 * Type definitions for Sybase ASE schema introspection.
 *
 * These describe the metadata extracted from the system catalogs
 * (sysobjects / syscolumns / systypes / sysindexes) and the configuration
 * accepted by {@link introspectSybase}.
 */

/**
 * Minimal database surface required by the introspection layer.
 *
 * Intentionally narrower than {@link SybaseDrizzle} so the fetch functions can
 * be unit-tested with a lightweight mock that only implements `executeRaw`.
 */
export interface IntrospectDb {
  executeRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    rawSql: string
  ): Promise<{ rows: T[]; rowCount: number }>;
}

/** Configuration for {@link introspectSybase}. */
export interface IntrospectConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  /** Restrict introspection to these tables. When omitted, all user tables are introspected. */
  tables?: string[];
  /** Restrict introspection to tables owned by this user (e.g. `dbo`). */
  owner?: string;
  /** Per-query timeout in seconds. Default: 30. */
  timeout?: number;
}

/** A single column as described by the Sybase system catalogs. */
export interface ColumnMeta {
  name: string;
  colid: number;
  /** Resolved base system type name, lower-cased (UDTs already resolved). */
  typeName: string;
  length: number;
  precision: number | null;
  scale: number | null;
  isNullable: boolean;
  isIdentity: boolean;
  defaultValue: string | null;
}

/** A single index as described by `sysindexes`. */
export interface IndexMeta {
  indexName: string;
  isPrimary: boolean;
  isUnique: boolean;
  /** Key column names, in key order. */
  columns: string[];
}

/** A user table together with its columns and indexes. */
export interface TableMeta {
  name: string;
  owner: string;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
}
