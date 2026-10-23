/**
 * Type-level inference for the select builder.
 *
 * Types only — nothing here exists at runtime. The shapes mirror what the
 * builder actually produces:
 *
 * - With no fields, every column of every source table is selected, aliased to
 *   its property name, into one flat row (see `SybaseSelectBuilder`'s implicit
 *   field list). A property shared by two tables is a runtime error there, and
 *   an error type here.
 * - With fields, each key holds that field's value.
 *
 * An outer join makes the other side's columns nullable: a left join the joined
 * table, a right join every table before it.
 */
import type { Column, GetColumnData, SQL } from "drizzle-orm";

import type { SybaseColumn, SybaseColumnRead } from "../columns/index.js";
import type { AnySybaseTable, SybaseTableKey } from "../table.js";

/** A value `db.select({ ... })` accepts for one field. */
export type SybaseSelectFieldValue =
  | SybaseColumn<any, string>
  /**
   * A column as drizzle's helpers type it — e.g. from `getColumns(table)`,
   * which describes Sybase columns with drizzle's general column type.
   */
  | Column
  | SQL<any>
  | SQL.Aliased<any>
  /** A raw SQL expression; its value type is unknown. */
  | string;

/** The fields object passed to `db.select({ ... })`. */
export type SybaseSelectFields = Record<string, SybaseSelectFieldValue>;

/** What the builder knows about its query, carried from `select()` through every join. */
export interface SybaseSelectState {
  /** The fields passed to `select()`, or `undefined` to select every column. */
  fields: SybaseSelectFields | undefined;
  /** Row type of each source table, by table name. */
  rows: Record<string, Record<string, unknown>>;
  /** Whether each source table's columns may come back null because of an outer join. */
  nullable: Record<string, boolean>;
  /** A source was given by name, so its columns are unknown. */
  named: boolean;
}

/** State of a fresh `select()` / `select(fields)`, before `from()`. */
export type InitialSelectState<TFields extends SybaseSelectFields | undefined> = {
  fields: TFields;
  rows: Record<never, never>;
  nullable: Record<never, never>;
  named: false;
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I
) => void
  ? I
  : never;

/** Key of a table defined with `sybaseTable` (see `SybaseTableKey`). */
export type TableKeyOf<T> = T extends AnySybaseTable
  ? SybaseTableKey<T["_"]["name"], T["_"]["schema"]>
  : never;

/** Every value of a row made nullable. */
type NullableRow<R> = { [K in keyof R]: R[K] | null };

/** Every table seen so far marked nullable, as a right join leaves them. */
type AllNullable<S extends SybaseSelectState> = { [N in keyof S["nullable"]]: true };

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export type WithFrom<S extends SybaseSelectState, T extends AnySybaseTable> = {
  fields: S["fields"];
  rows: { [N in TableKeyOf<T>]: T["$inferSelect"] };
  nullable: { [N in TableKeyOf<T>]: false };
  named: S["named"];
};

export type WithJoin<
  S extends SybaseSelectState,
  T extends AnySybaseTable,
  TJoin extends "inner" | "left" | "right"
> = {
  fields: S["fields"];
  rows: Simplify<S["rows"] & { [N in TableKeyOf<T>]: T["$inferSelect"] }>;
  nullable: Simplify<
    (TJoin extends "right" ? AllNullable<S> : S["nullable"]) & {
      [N in TableKeyOf<T>]: TJoin extends "left" ? true : false;
    }
  >;
  named: S["named"];
};

/** `from()` / a join given a table by name: its columns are unknown. */
export type WithNamedSource<
  S extends SybaseSelectState,
  TJoin extends "from" | "inner" | "left" | "right" = "from"
> = {
  fields: S["fields"];
  rows: S["rows"];
  nullable: TJoin extends "right" ? AllNullable<S> : S["nullable"];
  named: true;
};

/** Property names of every source row. */
type AllRowKeys<R> = { [N in keyof R]: keyof R[N] }[keyof R];

/**
 * Properties a join would add that an earlier table already has. Only a select
 * with no fields and no table given by name flattens every column into one row
 * (and throws at runtime on a clash); otherwise nothing can clash.
 */
type JoinClash<S extends SybaseSelectState, T extends AnySybaseTable> = [S["fields"]] extends [
  undefined
]
  ? S["named"] extends true
    ? never
    : keyof T["$inferSelect"] & AllRowKeys<S["rows"]>
  : never;

/**
 * Intersected with a join's table parameter: nothing normally, but a type no
 * table satisfies when the join would clash — so the call itself fails to
 * compile, with the reason in the message, rather than throwing at runtime.
 */
export type JoinGuard<S extends SybaseSelectState, T extends AnySybaseTable> = [
  JoinClash<S, T>
] extends [never]
  ? unknown
  : SybaseSelectError<`Property "${JoinClash<S, T> & string}" exists in more than one table; pass the fields explicitly, e.g. db.select({ ... })`>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Message type for a select the builder cannot run; see {@link JoinGuard}.
 */
export type SybaseSelectError<TMessage extends string> = { readonly $error: TMessage };

/**
 * The row of a select with no fields: every column of every source table,
 * flattened. A property clash cannot reach here — {@link JoinGuard} rejects the
 * join that would cause it.
 */
type ImplicitRow<S extends SybaseSelectState> = S["named"] extends true
  ? Record<string, unknown>
  : Simplify<
      UnionToIntersection<
        {
          [N in keyof S["rows"]]: N extends keyof S["nullable"]
            ? S["nullable"][N] extends true
              ? NullableRow<S["rows"][N]>
              : S["rows"][N]
            : S["rows"][N];
        }[keyof S["rows"]]
      >
    >;

/** `null` if `N` is the name of a table an outer join made nullable. */
type JoinNull<S extends SybaseSelectState, N> = N extends keyof S["nullable"]
  ? S["nullable"][N] extends true
    ? null
    : never
  : never;

/** The value one field of a select returns. */
type FieldResult<F, S extends SybaseSelectState> =
  F extends SybaseColumn<any, infer N>
    ? SybaseColumnRead<F> | JoinNull<S, N>
    : F extends SQL.Aliased<infer T>
      ? T
      : F extends SQL<infer T>
        ? T
        : F extends Column
          ? GetColumnData<F>
          : unknown;

/** The row type a select produces. */
export type SybaseSelectResult<S extends SybaseSelectState> = S["fields"] extends SybaseSelectFields
  ? Simplify<{ [K in keyof S["fields"]]: FieldResult<S["fields"][K], S> }>
  : ImplicitRow<S>;
