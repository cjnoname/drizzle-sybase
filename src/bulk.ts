/**
 * Bulk copy into a table, in process: db-lib's bcp API, driven chunk by chunk.
 *
 * This module turns the caller's rows into chunks for the native layer and
 * keeps the books — which batch is open, what the server confirmed — so that
 * the result, and every failure, says exactly what was committed. The native
 * side (`bulkBegin` / `bulkSend` in binding.c) converts and checks each value;
 * the connection (`SybaseConnection.bulkInsert`) supplies the I/O, the
 * deadline, and discards itself when a copy fails part way.
 */
import { checkInteger, MAX_INT32 } from "./checks.js";
import { formatSybaseDateTime } from "./datetime.js";
import { messageOf, SybaseBulkCopyError } from "./errors.js";
import type { SybaseBulkBatch, SybaseBulkRejectedRow } from "./errors.js";
import type {
  NativeBulkBeginOptions,
  NativeBulkBeginResult,
  NativeBulkChunkHeader,
  NativeBulkColumn,
  NativeBulkPayload,
  NativeBulkSendResult
} from "./native/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One value of a row given to {@link SybaseBulkInsertOptions.rows}. What each
 * column type accepts:
 *
 * | Column                                 | Accepts                                                        |
 * | -------------------------------------- | -------------------------------------------------------------- |
 * | `tinyint`, `smallint`, `int`, `bigint` | an integer `number` (safe integers only), a `bigint`, a digit string |
 * | `money`, `smallmoney`                  | a decimal string (`"12.3456"`) — not a `bigint`, whose unit (whole amounts or ten-thousandths) could only be guessed |
 * | `numeric(p,s)`, `decimal(p,s)`         | a decimal string or a `bigint`; a `number` if `p` ≤ 15         |
 * | `float`, `real`                        | a `number` or a numeric string                                 |
 * | `bit`                                  | a `boolean`, `0`/`1`, `"0"`/`"1"`                              |
 * | `datetime`, `smalldatetime`            | a `Date` (written in the connection's `timeZone`), or a wall-clock string `YYYY-MM-DD[ HH:MM[:SS[.mmm]]]`, stored as written |
 * | `char`, `varchar`                      | a `string`                                                     |
 * | `binary`, `varbinary`                  | a `Uint8Array` / `Buffer`                                      |
 *
 * `null` and `undefined` are NULL — which, as with the bcp utility, a column
 * with a DEFAULT replaces by its default (unless `ignoreDefaults`).
 */
export type SybaseBulkValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | null
  | undefined;

/** One row: a value per copied column, in the order of `columns`. */
export type SybaseBulkRow = readonly SybaseBulkValue[];

/**
 * The rows of a bulk copy:
 *
 * - **Value rows** — an `Iterable` or `AsyncIterable` of arrays (a generator, an
 *   array of arrays, a stream in object mode). Pulled as the copy goes, so the
 *   input is never held whole (memory: about three chunks of up to 4 MiB, plus
 *   one entry per committed batch in the result).
 * - **TSV** — a `string` or `Uint8Array`/`Buffer` of UTF-8 text, or an
 *   `Iterable`/`AsyncIterable` of such pieces (e.g. `fs.createReadStream`),
 *   split anywhere. bcp character format: fields separated by tab, rows by
 *   newline (`\r\n` too); an empty field is NULL; no quoting or escaping, so a
 *   value cannot contain a tab or newline. Binary columns are hex.
 */
export type SybaseBulkRows =
  | string
  | Uint8Array
  | Iterable<SybaseBulkRow>
  | AsyncIterable<SybaseBulkRow>
  | Iterable<string | Uint8Array>
  | AsyncIterable<string | Uint8Array>;

/** Options of `bulkInsert`. */
export interface SybaseBulkInsertOptions {
  /**
   * The target: `db..table`, `db.owner.table`, `owner.table`, `table`, or a
   * `#temp` table of the same connection (`withConnection`). Plain identifiers
   * only — no brackets or quotes; at most 92 characters.
   */
  table: string;
  /**
   * The columns the rows give values for, in that order. Default: every column
   * in table order, except identity columns (unless `keepIdentity`) and
   * `timestamp`. Columns left out get NULL, or their DEFAULT.
   */
  columns?: readonly string[];
  /** The rows; see {@link SybaseBulkRows}. */
  rows: SybaseBulkRows;
  /**
   * Input rows per batch; each batch is committed on its own. `"all"` (the
   * default) makes the whole call one batch: it then commits everything or
   * nothing.
   *
   * ASE escalates to a table lock once a batch holds more rows than the
   * table's row lock promotion HWM (200 by default for datarows/datapages
   * tables, raised to 25,000 on many servers): a larger batch locks the whole
   * table until it commits. Keep batches below it on a table others use.
   */
  batchSize?: number | "all";
  /**
   * Fail unless exactly this many rows are copied. Checked before the last
   * commit, so a mismatch commits nothing more (earlier batches stay).
   */
  expectedRows?: number;
  /**
   * Copy the identity column's values from the rows (`set identity_insert on`
   * for the copy, as `bcp -E` does) instead of letting the server assign them.
   * The identity column must then be among `columns` (it is by default).
   */
  keepIdentity?: boolean;
  /**
   * Store NULL where a row gives NULL — and in columns left out of `columns` —
   * instead of the column's DEFAULT: ASE bcp's `--ignoredefaults`. A NULL for
   * a NOT NULL column then rejects the row, as for a column without a default.
   * Default `false`: as with the bcp utility, a NULL (an empty TSV field,
   * `null`, `undefined`) in a column that has a DEFAULT stores the default.
   */
  ignoreDefaults?: boolean;
  /**
   * Copy into a table that has an insert trigger, CHECK or foreign key
   * constraints, or rules. ASE's bulk copy applies none of them (nor does the
   * bcp utility): a row that breaks one is stored, and no trigger fires. So a
   * copy into such a table is refused unless this is `true` — set it only when
   * the rows are known to satisfy them, or that does not matter. Otherwise load
   * a staging table and `insert ... select` from it.
   */
  allowConstraintBypass?: boolean;
  /**
   * How many rows may be left out because a value cannot be converted before
   * the copy fails. Default 0: the first such row fails the copy. Rejected rows
   * are listed in the result. A duplicate key in a unique index, which the
   * server finds when it commits a batch, always fails that batch as a whole.
   * (CHECK constraints, foreign keys and triggers are not applied by a bulk
   * copy at all — see the README.)
   */
  maxErrors?: number;
  /**
   * Cooperative timeout, in seconds, for each wait on the server during the
   * copy — including the commit of a batch, which on a large indexed table
   * can take a while. Default: the connection's `timeout`.
   */
  timeoutSeconds?: number;
  /**
   * Deadline for the whole call, in ms. When it passes the copy is abandoned:
   * the connection is closed, which makes the server roll back the open batch.
   * Default: `max(2 * timeoutSeconds * 1000, 30000)`.
   */
  hardTimeoutMs?: number;
}

/** What a successful bulk copy did. */
export interface SybaseBulkInsertResult {
  /** Rows committed, as the server reported them — never a count of what was sent. */
  rowsCopied: number;
  /** Every batch committed, in order. */
  batches: SybaseBulkBatch[];
  /** Rows left out under `maxErrors` (at most 1000 listed, in the order they were found). */
  rejected: SybaseBulkRejectedRow[];
  /** How many rows were left out under `maxErrors`. */
  rejectedCount: number;
  /** Wall-clock duration of the call, in ms. */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A plain identifier, as `is_table_name` in binding.c accepts it. */
const IDENTIFIER = /^[A-Za-z_@#][A-Za-z0-9_@#$]*$/;

/**
 * Whether `table` is `table`, `owner.table`, `db..table` or `db.owner.table` —
 * a `#temp` table only on its own: it is in the session's temporary database,
 * which a qualified name would look past.
 */
const isTableName = (table: string): boolean => {
  if (table.length === 0 || table.length > 92) {
    return false;
  }
  const parts = table.split(".");
  if (parts.length > 3 || (parts.length > 1 && parts.some(part => part.startsWith("#")))) {
    return false;
  }
  return parts.every(
    (part, i) => IDENTIFIER.test(part) || (parts.length === 3 && i === 1 && part === "")
  );
};

/**
 * Reject bad options before a connection is taken for them.
 *
 * @internal
 */
export const validateBulkInsertOptions = (options: SybaseBulkInsertOptions): void => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("bulkInsert: expected an options object");
  }
  if (typeof options.table !== "string" || !isTableName(options.table)) {
    throw new TypeError(
      "bulkInsert: table must be `table`, `owner.table`, `db..table` or `db.owner.table` of plain " +
        "identifiers (letters, digits, _ @ # $), at most 92 characters — a #temp table on its " +
        `own; got ${String(options.table)}`
    );
  }
  if (
    options.columns !== undefined &&
    !(
      Array.isArray(options.columns) &&
      options.columns.length > 0 &&
      options.columns.every(name => typeof name === "string" && name !== "")
    )
  ) {
    throw new TypeError("bulkInsert: columns must be a non-empty array of column names");
  }
  const rows: unknown = options.rows;
  if (
    !(typeof rows === "string" || rows instanceof Uint8Array || iterationOf(rows) !== undefined)
  ) {
    throw new TypeError(
      "bulkInsert: rows must be TSV (a string or Buffer), or an iterable of rows or TSV pieces"
    );
  }
  if (options.batchSize !== "all") {
    checkInteger("batchSize", options.batchSize, 1, MAX_INT32);
  }
  checkInteger("expectedRows", options.expectedRows, 0, Number.MAX_SAFE_INTEGER);
  checkInteger("maxErrors", options.maxErrors, 0, Number.MAX_SAFE_INTEGER);
  checkInteger("timeoutSeconds", options.timeoutSeconds, 1, Math.floor(MAX_INT32 / 2000));
  checkInteger("hardTimeoutMs", options.hardTimeoutMs, 1, MAX_INT32);
  for (const flag of ["keepIdentity", "ignoreDefaults", "allowConstraintBypass"] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== "boolean") {
      throw new TypeError(`bulkInsert: ${flag} must be a boolean`);
    }
  }
};

// ---------------------------------------------------------------------------
// Encoding values
// ---------------------------------------------------------------------------

/** Why a value cannot be copied; becomes a rejected row. */
class BulkValueError extends Error {}

/** Turns one value into the text the native layer converts, or `null` for NULL. */
type Encoder = (value: unknown) => string | null;

const describe = (value: unknown): string =>
  value instanceof Date
    ? "a Date"
    : value instanceof Uint8Array
      ? "bytes"
      : Array.isArray(value)
        ? "an array"
        : `a ${typeof value}`;

const refuse = (value: unknown, column: NativeBulkColumn, accepts: string): never => {
  throw new BulkValueError(`is ${describe(value)}; a ${column.type} column takes ${accepts}`);
};

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * A finite number as a decimal literal without an exponent: `String` writes
 * 1e-7 and 1e21, which the exact decimal parser does not take. The digits are
 * those of `String` — the shortest that read back as the same double — moved.
 */
const plainDecimal = (value: number): string => {
  const text = String(value);
  const e = text.indexOf("e");
  if (e < 0) {
    return text;
  }
  const sign = text.startsWith("-") ? "-" : "";
  const mantissa = text.slice(sign.length, e);
  const dot = mantissa.indexOf(".");
  const digits = mantissa.replace(".", "");
  const point = (dot < 0 ? mantissa.length : dot) + Number(text.slice(e + 1));
  return point <= 0
    ? `${sign}0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? `${sign}${digits}${"0".repeat(point - digits.length)}`
      : `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/**
 * How `value` is iterated, as `for await` would (GetMethod): through
 * `Symbol.asyncIterator` unless it is null or undefined, else through
 * `Symbol.iterator`; `undefined` if it is not iterable.
 */
const iterationOf = (value: unknown): "async" | "sync" | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const source = value as { [Symbol.asyncIterator]?: unknown; [Symbol.iterator]?: unknown };
  const asyncMethod = source[Symbol.asyncIterator];
  if (asyncMethod !== undefined && asyncMethod !== null) {
    return typeof asyncMethod === "function" ? "async" : undefined;
  }
  return typeof source[Symbol.iterator] === "function" ? "sync" : undefined;
};

/** How many newlines `text` holds. */
const countNewlines = (text: string | Uint8Array): number => {
  let n = 0;
  if (typeof text === "string") {
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
      n++;
    }
  } else {
    for (let at = text.indexOf(10); at !== -1; at = text.indexOf(10, at + 1)) {
      n++;
    }
  }
  return n;
};

/**
 * Refuse text with a lone surrogate: encoded to UTF-8 it would silently become
 * U+FFFD. (Value rows reach the native side as UTF-16, which refuses it there.)
 */
const checkWellFormed = (text: string): void => {
  if (!text.isWellFormed()) {
    throw new TypeError("bulkInsert: the TSV has an unpaired surrogate: it is not valid text");
  }
};

/**
 * Longest value accepted for a column that is not text or binary, in
 * characters (BULK_TOKEN_MAX - 1 in binding.c, which refuses any longer).
 * Refused here too, before a long one is copied into a chunk: the lengths of
 * text and binary values are bounded by their columns, so a row's size is
 * bounded by its table's.
 */
const MAX_TOKEN_LENGTH = 127;

/** The types whose values are tokens (numbers, dates, bits) rather than text or bytes. */
const TOKEN_TYPES = new Set([
  "tinyint",
  "smallint",
  "int",
  "bigint",
  "money",
  "smallmoney",
  "numeric",
  "decimal",
  "float",
  "real",
  "bit",
  "datetime",
  "smalldatetime"
]);

/** How the values of a column are given to the native layer, by its type. */
const encoderFor = (column: NativeBulkColumn, timeZone: string): Encoder => {
  switch (column.type) {
    case "tinyint":
    case "smallint":
    case "int":
    case "bigint":
      return value => {
        if (value == null) {
          return null;
        }
        if (typeof value === "string" || typeof value === "bigint") {
          return String(value);
        }
        if (typeof value === "number" && Number.isSafeInteger(value)) {
          return String(value);
        }
        return refuse(
          value,
          column,
          "an integer: a safe-integer number, a bigint or a digit string"
        );
      };
    case "money":
    case "smallmoney":
      // Not a bigint: amounts are commonly held as integers of ten-thousandths
      // as well as of whole units, and the two differ by 10,000 — a guess
      // either way would store some callers' amounts wrong, silently.
      return value => {
        if (value == null) {
          return null;
        }
        if (typeof value === "string") {
          return value;
        }
        return refuse(
          value,
          column,
          'a decimal string ("12.3456"); a bigint is refused, as its unit would be a guess'
        );
      };
    case "numeric":
    case "decimal": {
      // A number holds 15–17 significant digits: fine for a narrow numeric,
      // silently wrong for the rest (as in the query builders).
      const numbers = column.precision <= 15;
      return value => {
        if (value == null) {
          return null;
        }
        if (typeof value === "string" || typeof value === "bigint") {
          return String(value);
        }
        if (numbers && typeof value === "number" && Number.isFinite(value)) {
          return plainDecimal(value);
        }
        return refuse(
          value,
          column,
          numbers
            ? "a decimal string, a bigint or a number"
            : "a decimal string or a bigint, not a number"
        );
      };
    }
    case "float":
    case "real":
      return value => {
        if (value == null) {
          return null;
        }
        if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
          return String(value);
        }
        return refuse(value, column, "a finite number or a numeric string");
      };
    case "bit":
      return value => {
        if (value == null) {
          return null;
        }
        if (typeof value === "boolean") {
          return value ? "1" : "0";
        }
        if (value === 0 || value === 1 || value === "0" || value === "1") {
          return String(value);
        }
        return refuse(value, column, "a boolean, 0 or 1");
      };
    case "datetime":
    case "smalldatetime":
      return value => {
        if (value == null) {
          return null;
        }
        if (typeof value === "string") {
          return value;
        }
        if (value instanceof Date) {
          try {
            return formatSybaseDateTime(value, timeZone);
          } catch (err) {
            throw new BulkValueError(err instanceof Error ? err.message : String(err));
          }
        }
        return refuse(value, column, "a Date or a YYYY-MM-DD HH:MM:SS.mmm string");
      };
    case "binary":
    case "varbinary":
      return value => {
        if (value == null) {
          return null;
        }
        if (value instanceof Uint8Array) {
          if (value.length === 0) {
            throw new BulkValueError("is empty: ASE has no zero-length binary value");
          }
          if (value.length > column.length) {
            throw new BulkValueError(`is ${value.length} bytes; the column holds ${column.length}`);
          }
          let hex = "";
          for (const byte of value) {
            hex += HEX[byte];
          }
          return hex;
        }
        return refuse(value, column, "a Uint8Array or Buffer");
      };
    default:
      // char, varchar (reported as char), nchar, nvarchar
      return value => {
        if (value == null) {
          return null;
        }
        if (typeof value === "string") {
          // Every UTF-16 unit takes a byte or more in the server's character
          // set, so a value with more (trailing blanks aside, which ASE drops)
          // cannot fit: refused here, before it is copied to the native side.
          let end = value.length;
          while (end > column.length && value.charCodeAt(end - 1) === 0x20) {
            end--;
          }
          if (end > column.length) {
            throw new BulkValueError(
              `is at least ${end} bytes in the server's character set; the column holds ${column.length}`
            );
          }
          return end === value.length ? value : value.slice(0, end);
        }
        return refuse(value, column, "a string");
      };
  }
};

// ---------------------------------------------------------------------------
// Reading rows into chunks
// ---------------------------------------------------------------------------

/** Most input rows per native call. */
const CHUNK_ROWS = 10_000;
/** Roughly the most data per native call: 4 MiB of TSV, 2M UTF-16 units of values. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** TSV gathered from a streamed source before a chunk is cut from it. */
const CHUNK_FILL = 1024 * 1024;
/**
 * Longest TSV row accepted: a bound on what one row may make the reader buffer.
 * Far beyond a real ASE row (one fits in a page) even as hex text.
 */
const MAX_TSV_ROW_BYTES = CHUNK_BYTES;
/** Size of the blocks small streamed TSV pieces are copied into. */
const TSV_BLOCK_BYTES = 64 * 1024;
/** Input rows read between checks of the deadline. */
const DEADLINE_CHECK_ROWS = 1024;
const CHUNK_UNITS = 2 * 1024 * 1024;
/** Field length marking NULL (BULK_NULL in binding.c). */
const NULL_LENGTH = 0xffffffff;

/** A chunk of rows ready for `bulkSend`. */
interface Chunk {
  payload: NativeBulkPayload;
  /** Rows in the payload. */
  rows: number;
  /** 1-based input row number of the payload's first row. */
  firstRow: number;
  /** Input rows consumed, including any rejected before reaching the payload. */
  inputRows: number;
  /** Whether the chunk completes a batch. */
  endsBatch: boolean;
  /**
   * Rows refused while reading it. Counted against `maxErrors` only when the
   * chunk is about to be sent: a chunk is read while the one before it is still
   * being sent, and the native side may refuse rows of that one meanwhile.
   */
  refused: RefusedRow[];
}

/** A row the reader refused. */
interface RefusedRow {
  rejected: SybaseBulkRejectedRow;
  cause: Error;
}

/** Pulls the caller's rows and cuts them into chunks. */
class RowReader {
  private sync: Iterator<unknown> | undefined;
  private async: AsyncIterator<unknown> | undefined;
  private mode: "values" | "tsv" | undefined;
  /** Input rows read so far. */
  private rowNumber = 0;
  /** TSV not yet cut into rows (from `pendingStart`): a string, or bytes. */
  private pending: string | Buffer = "";
  private pendingStart = 0;
  /** TSV read but not yet joined onto `pending`, then what of `block` is not yet in it. */
  private pieces: Buffer[] = [];
  private piecesBytes = 0;
  /**
   * Where small pieces are copied to, back to back: a source of tiny pieces
   * would otherwise hold one Buffer per piece. `block[blockStart, blockFill)`
   * is buffered but not yet in `pieces`.
   */
  private block: Buffer | undefined;
  private blockStart = 0;
  private blockFill = 0;
  /** Complete rows buffered (in `pending` from `pendingStart`, and in `pieces`): their newlines. */
  private newlines = 0;
  /** A high surrogate that ended a string piece, waiting for its other half. */
  private highSurrogate = "";
  private sourceDone = false;
  /** Rows refused so far by the reader. */
  private refusedCount = 0;
  /** Rows refused but not yet handed over in a chunk (see takeRefused). */
  private refused: RefusedRow[] = [];
  /** A value row read but not yet placed in a chunk. */
  private heldRow: unknown;
  /** Per column: whether its values are tokens (see MAX_TOKEN_LENGTH). */
  private readonly tokens: boolean[];
  private holding = false;

  constructor(
    rows: SybaseBulkRows,
    private readonly columns: NativeBulkColumn[],
    private readonly encoders: Encoder[],
    /** The copy fails once the reader alone refuses more rows than this. */
    private readonly maxErrors: number,
    /** Throws once the copy's deadline has passed; see BulkIo.checkDeadline. */
    private readonly checkDeadline: () => void
  ) {
    this.tokens = columns.map(column => TOKEN_TYPES.has(column.type));
    if (typeof rows === "string" || rows instanceof Uint8Array) {
      if (typeof rows === "string") {
        checkWellFormed(rows);
      }
      this.mode = "tsv";
      this.pending =
        typeof rows === "string"
          ? rows
          : Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength);
      this.sourceDone = true;
    } else if (iterationOf(rows) === "async") {
      this.async = (rows as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    } else {
      this.sync = (rows as Iterable<unknown>)[Symbol.iterator]();
    }
  }

  /** Let the source clean up after a failed copy (e.g. close a file stream). Once. */
  close(): void {
    const sync = this.sync;
    const async = this.async;
    this.sync = undefined;
    this.async = undefined;
    try {
      void Promise.resolve(async?.return?.()).catch(() => {});
      sync?.return?.();
    } catch {
      // The source's own cleanup failing changes nothing here.
    }
  }

  private async pull(): Promise<IteratorResult<unknown>> {
    if (this.sync) {
      return this.sync.next();
    }
    if (this.async) {
      return this.async.next();
    }
    return { done: true, value: undefined }; // closed
  }

  /**
   * The rows refused since the last chunk. A failed read hands them over this
   * way, so that the copy's error still lists them.
   */
  takeRefused(): RefusedRow[] {
    const refused = this.refused;
    this.refused = [];
    return refused;
  }

  /**
   * Known to have no more rows: the source has ended and nothing it gave is
   * left unread — as soon as the last chunk is cut from TSV given whole. (Not
   * knowing does not mean there are more: an iterated source is known to have
   * ended only once read past its last row.)
   */
  get exhausted(): boolean {
    return (
      this.sourceDone &&
      !this.holding &&
      this.refused.length === 0 &&
      this.pendingStart >= this.pending.length &&
      this.piecesBytes === 0 &&
      this.blockFill === this.blockStart &&
      this.highSurrogate === ""
    );
  }

  /**
   * The next chunk of at most `maxRows` input rows, or `null` at the end — and
   * once the reader alone has refused more than `maxErrors` rows: the chunk
   * holding the one past the limit is never sent (the copy fails as it is
   * counted), so there is nothing more to read.
   */
  async next(maxRows: number): Promise<Chunk | null> {
    if (this.refusedCount > this.maxErrors) {
      return null;
    }
    if (this.mode === undefined) {
      if (this.sourceDone) {
        return null;
      }
      const first = await this.pull();
      if (first.done) {
        this.sourceDone = true;
        return null;
      }
      if (Array.isArray(first.value)) {
        this.mode = "values";
        this.heldRow = first.value;
        this.holding = true;
      } else {
        this.mode = "tsv";
        this.addTsv(first.value);
      }
    }
    return this.mode === "values" ? this.nextValues(maxRows) : this.nextTsv(maxRows);
  }

  // --- Value rows ---

  private async nextValues(maxRows: number): Promise<Chunk | null> {
    const parts: string[] = [];
    const lens: number[] = [];
    let units = 0;
    let rows = 0;
    let inputRows = 0;
    let firstRow = 0;
    const width = this.columns.length;
    const fields: (string | null)[] = Array.from({ length: width });
    // Lengths count too (4 bytes, two units, each): a wide row of NULLs is
    // all lengths and no text.
    while (inputRows < maxRows && units + lens.length * 2 < CHUNK_UNITS) {
      let row: unknown;
      if (this.holding) {
        row = this.heldRow;
        this.holding = false;
        this.heldRow = undefined;
      } else {
        if (this.sourceDone) {
          break;
        }
        const item = await this.pull();
        if (item.done) {
          this.sourceDone = true;
          break;
        }
        row = item.value;
      }
      const rowNumber = ++this.rowNumber;
      inputRows++;
      if (inputRows % DEADLINE_CHECK_ROWS === 0) {
        this.checkDeadline();
      }
      const problem = this.encodeRow(row, width, fields);
      if (problem) {
        this.refused.push({
          rejected: { row: rowNumber, ...problem.rejected },
          cause: problem.cause
        });
        this.refusedCount++;
        // Rows of a chunk are numbered consecutively: end it at the gap — and
        // read no further once past the limit (see next).
        if (rows > 0 || this.refusedCount > this.maxErrors) {
          break;
        }
        continue;
      }
      if (rows === 0) {
        firstRow = rowNumber;
      }
      for (const field of fields) {
        if (field === null) {
          lens.push(NULL_LENGTH);
        } else {
          parts.push(field);
          lens.push(field.length);
          units += field.length;
        }
      }
      rows++;
    }
    if (inputRows === 0) {
      return null;
    }
    return {
      payload: { text: parts.join(""), lens: Uint32Array.from(lens) },
      rows,
      firstRow: rows > 0 ? firstRow : this.rowNumber + 1,
      inputRows,
      endsBatch: false,
      refused: this.takeRefused()
    };
  }

  /** Encode `row` into `fields`; what is wrong with it, if anything. */
  private encodeRow(
    row: unknown,
    width: number,
    fields: (string | null)[]
  ): { rejected: Omit<SybaseBulkRejectedRow, "row">; cause: Error } | undefined {
    if (!Array.isArray(row)) {
      // TSV among value rows is a source mixing the two — not a bad row, which
      // maxErrors could skip: the copy stops, as for an array among TSV pieces.
      if (typeof row === "string" || row instanceof Uint8Array) {
        throw new TypeError(
          `bulkInsert: a source of value rows yielded ${describe(row)}; ` +
            "rows cannot mix TSV and arrays"
        );
      }
      const message = `is ${describe(row)}, not an array of values`;
      return { rejected: { message }, cause: new TypeError(message) };
    }
    if (row.length !== width) {
      const message = `has ${row.length} values; ${width} columns are copied`;
      return { rejected: { message }, cause: new TypeError(message) };
    }
    for (let k = 0; k < width; k++) {
      try {
        const field = this.encoders[k](row[k]);
        if (field !== null && field.length > MAX_TOKEN_LENGTH && this.tokens[k]) {
          throw new BulkValueError(
            `is ${field.length} characters long: no ${this.columns[k].type} value is written ` +
              `with more than ${MAX_TOKEN_LENGTH}`
          );
        }
        fields[k] = field;
      } catch (err) {
        if (!(err instanceof BulkValueError)) {
          throw err;
        }
        return {
          rejected: { column: this.columns[k].name, message: `value ${err.message}` },
          cause: new TypeError(`column '${this.columns[k].name}': value ${err.message}`)
        };
      }
    }
    return undefined;
  }

  // --- TSV ---

  private addTsv(piece: unknown): void {
    if (typeof piece !== "string" && !(piece instanceof Uint8Array)) {
      throw new TypeError(
        `bulkInsert: a TSV source yielded ${describe(piece)}; expected strings or Buffers ` +
          "(rows cannot mix TSV and arrays)"
      );
    }
    if (typeof piece === "string") {
      // A string may be split between the two halves of a surrogate pair: the
      // high one waits for the next piece.
      let text = this.highSurrogate + piece;
      this.highSurrogate = "";
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.highSurrogate = text.slice(-1);
        text = text.slice(0, -1);
      }
      checkWellFormed(text);
      this.addBytes(Buffer.byteLength(text, "utf8"), countNewlines(text), (target, at) =>
        target.write(text, at, "utf8")
      );
    } else if (piece.byteLength > 0) {
      this.checkNoHalfCharacter();
      // Copied: the source may reuse its buffer for the next piece, and this
      // one is held until a chunk is cut from it.
      this.addBytes(piece.byteLength, countNewlines(piece), (target, at) => target.set(piece, at));
    }
  }

  /** Buffer `length` bytes that `write` puts at `target[at]`. */
  private addBytes(
    length: number,
    newlines: number,
    write: (target: Buffer, at: number) => void
  ): void {
    if (length === 0) {
      return;
    }
    if (length >= TSV_BLOCK_BYTES) {
      this.flushBlock();
      const own = Buffer.allocUnsafe(length);
      write(own, 0);
      this.pieces.push(own);
    } else {
      if (!this.block || this.blockFill + length > this.block.length) {
        this.flushBlock();
        this.block = Buffer.allocUnsafe(TSV_BLOCK_BYTES);
        this.blockStart = this.blockFill = 0;
      }
      write(this.block, this.blockFill);
      this.blockFill += length;
    }
    this.piecesBytes += length;
    this.newlines += newlines;
  }

  /** Move what `block` holds that is not yet in `pieces` there, keeping order. */
  private flushBlock(): void {
    if (this.block && this.blockFill > this.blockStart) {
      this.pieces.push(this.block.subarray(this.blockStart, this.blockFill));
      this.blockStart = this.blockFill;
    }
  }

  private checkNoHalfCharacter(): void {
    if (this.highSurrogate) {
      throw new TypeError(
        `bulkInsert: row ${this.rowNumber + 1} of the TSV has an unpaired surrogate (U+` +
          `${this.highSurrogate.charCodeAt(0).toString(16).toUpperCase()}) at the end of a string piece`
      );
    }
  }

  /**
   * Join the pieces read since the last chunk onto what is left of `pending`, in
   * one copy — none when all there is is one piece: it is already this reader's
   * own (see addTsv), and a block is only ever written past what it holds.
   */
  private materialize(): void {
    if (this.piecesBytes === 0) {
      return;
    }
    this.flushBlock();
    const rest =
      typeof this.pending === "string"
        ? Buffer.from(this.pending.slice(this.pendingStart), "utf8")
        : this.pending.subarray(this.pendingStart);
    this.pending =
      rest.length === 0 && this.pieces.length === 1
        ? this.pieces[0]!
        : Buffer.concat([rest, ...this.pieces]);
    this.pendingStart = 0;
    this.pieces = [];
    this.piecesBytes = 0;
  }

  private newlineAt(from: number): number {
    return typeof this.pending === "string"
      ? this.pending.indexOf("\n", from)
      : this.pending.indexOf(10, from);
  }

  private async pullTsv(): Promise<void> {
    this.checkDeadline();
    const item = await this.pull();
    if (item.done) {
      this.sourceDone = true;
      this.checkNoHalfCharacter();
    } else {
      this.addTsv(item.value);
    }
  }

  private rowTooLong(withNewline: boolean, row = this.rowNumber + 1): TypeError {
    return new TypeError(
      `row ${row} of the TSV is longer than ${MAX_TSV_ROW_BYTES} bytes` +
        (withNewline ? "" : " with no newline: rows must end with \\n")
    );
  }

  private async nextTsv(maxRows: number): Promise<Chunk | null> {
    for (;;) {
      // Read on until the rows wanted are buffered, gathering a worthwhile
      // amount meanwhile so that a source of small pieces does not make one
      // native call per piece — but no further once they are: a source that
      // pauses must not hold back a batch it has already given in full. With no
      // complete row buffered, pieces are only counted, not joined and rescanned.
      const buffered = this.pending.length - this.pendingStart + this.piecesBytes;
      if (
        !this.sourceDone &&
        this.newlines < maxRows &&
        (buffered < CHUNK_FILL || this.newlines === 0)
      ) {
        if (this.newlines === 0 && buffered > MAX_TSV_ROW_BYTES) {
          throw this.rowTooLong(false);
        }
        await this.pullTsv();
        continue;
      }
      this.materialize();
      const start = this.pendingStart;
      // A string is sent as UTF-8, which only sizing each row exactly tells —
      // a call per row. Its units are a lower bound of its bytes: the rows are
      // found by those first, and the chunk measured once; only when it may
      // break a limit are they found again row by row. Either way the same rows.
      const { end, rows } =
        typeof this.pending === "string"
          ? (this.scanRows(start, maxRows, false) ?? this.scanRows(start, maxRows, true)!)
          : this.scanRows(start, maxRows, true)!;
      if (rows > 0) {
        return this.cutTsv(start, end, rows);
      }
      if (this.sourceDone) {
        return null;
      }
      // No row ends within what is buffered: read on (see above).
    }
  }

  /**
   * The rows of the next chunk, from `start`: up to `maxRows`, and — but for
   * the first — no more than CHUNK_BYTES of what is sent. `exact` sizes each
   * row as sent (a string's UTF-8); otherwise a string's rows are sized by
   * their units, and `undefined` is returned when that cannot settle it: a row
   * that may be too long, or a chunk past CHUNK_BYTES once measured.
   */
  private scanRows(
    start: number,
    maxRows: number,
    exact: boolean
  ): { end: number; rows: number } | undefined {
    const pending = this.pending;
    const length = pending.length;
    const isString = typeof pending === "string";
    let end = start;
    let rows = 0;
    let bytes = 0;
    while (rows < maxRows) {
      let next = this.newlineAt(end) + 1;
      if (next === 0) {
        // No newline left: once the source has ended, the rest is the last row.
        if (!this.sourceDone || end === length) {
          break;
        }
        next = length;
      }
      let rowBytes = next - end;
      if (isString) {
        if (exact) {
          rowBytes = Buffer.byteLength(pending.slice(end, next), "utf8");
        } else if (rowBytes * 3 > MAX_TSV_ROW_BYTES) {
          return undefined; // its UTF-8 may be past the limit
        }
      }
      if (rowBytes > MAX_TSV_ROW_BYTES) {
        throw this.rowTooLong(true, this.rowNumber + rows + 1);
      }
      // Past the size limit: stop before this row, unless it is the first.
      if (rows > 0 && bytes + rowBytes > CHUNK_BYTES) {
        break;
      }
      bytes += rowBytes;
      end = next;
      rows++;
    }
    if (
      isString &&
      !exact &&
      rows > 1 &&
      Buffer.byteLength(pending.slice(start, end), "utf8") > CHUNK_BYTES
    ) {
      return undefined;
    }
    return { end, rows };
  }

  private cutTsv(start: number, end: number, rows: number): Chunk {
    const tsv =
      typeof this.pending === "string"
        ? this.pending.slice(start, end)
        : this.pending.subarray(start, end);
    this.pendingStart = end;
    // Each row cut ended at a newline, but for a last one without (the source
    // has ended then, and the count no longer matters).
    this.newlines = Math.max(0, this.newlines - rows);
    const firstRow = this.rowNumber + 1;
    this.rowNumber += rows;
    return { payload: { tsv }, rows, firstRow, inputRows: rows, endsBatch: false, refused: [] };
  }
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

/** What a connection provides for a copy; see `SybaseConnection.bulkInsert`. */
export interface BulkIo {
  begin(options: Omit<NativeBulkBeginOptions, "hardTimeoutMs">): Promise<NativeBulkBeginResult>;
  send(
    chunk: Omit<NativeBulkChunkHeader, "hardTimeoutMs"> & NativeBulkPayload
  ): Promise<NativeBulkSendResult>;
  /** `promise`, but rejecting once the copy's deadline has passed. */
  race<T>(promise: Promise<T>): Promise<T>;
  /** Whether the deadline has passed (the connection is then closed). */
  readonly expired: boolean;
  /**
   * Check the deadline now, acting on it — closing the connection — if it has
   * passed, and return whether it has. For loops that may not yield to the
   * event loop for long (a source whose rows are all ready at once), where the
   * deadline's timer could not fire on time.
   */
  checkDeadline(): boolean;
  /** The error a passed deadline stands for. */
  deadlineError(): Error;
  /** Close the connection: the server rolls back the open batch. */
  abandon(): void;
  /** The `SybaseError` a native failure stands for. */
  toCause(err: unknown): Error;
  /** IANA zone `Date` values are written in. */
  timeZone: string;
}

/** A native failure's progress fields. */
type NativeBulkFailure = Partial<NativeBulkSendResult> & {
  outcome?: "none" | "failed" | "unknown";
  reusable?: boolean;
  row?: number;
  column?: string;
  message?: string;
};

const COMMIT_NONE = 0;
const COMMIT_BATCH = 1;
const COMMIT_DONE = 2;

/** Most rejected rows listed in a result or error. */
const MAX_REJECTED_LISTED = 1000;

/**
 * Run a whole copy over `io`.
 *
 * @internal
 */
export const copyRows = async (
  io: BulkIo,
  options: SybaseBulkInsertOptions
): Promise<SybaseBulkInsertResult> => {
  const startedAt = performance.now();
  const batchSize =
    options.batchSize === undefined || options.batchSize === "all" ? Infinity : options.batchSize;
  const maxErrors = options.maxErrors ?? 0;
  const expected = options.expectedRows;

  const batches: SybaseBulkBatch[] = [];
  const rejected: SybaseBulkRejectedRow[] = [];
  let rejectedCount = 0;
  /** Rows the server has confirmed committed. */
  let committedRows = 0;
  /** Rows sent in the open batch (accepted by the native side). */
  let openRows = 0;
  /** Rows read and handed to the native side so far, rejected or not. */
  let readRows = 0;

  /** Lets the caller's source clean up (e.g. close a file stream); set once rows are read. */
  let closeReader = (): void => {};

  /** Whether the connection has been given up — by a failure, or a commit that discarded it. */
  let abandoned = false;
  const abandon = (): void => {
    abandoned = true;
    io.abandon();
  };

  const fail = (
    message: string,
    details: {
      cause?: unknown;
      rowsInDoubt?: number;
      row?: number;
      column?: string;
      abandon: boolean;
    }
  ): never => {
    closeReader();
    if (details.abandon) {
      abandon();
    }
    const doubt = details.rowsInDoubt ?? 0;
    const committed =
      committedRows === 0
        ? "No rows were committed"
        : `${committedRows} row${committedRows === 1 ? " was" : "s were"} committed by ` +
          `${batches.length} earlier batch${batches.length === 1 ? "" : "es"}`;
    const tail =
      doubt > 0
        ? `${committed}; the commit of the last batch (${doubt} rows) was under way when the ` +
          "answer was lost: those rows may or may not have been committed"
        : committedRows === 0
          ? committed
          : `${committed}; nothing else was`;
    // Server messages end in line breaks.
    const reason = message.trim().replace(/\.$/, "");
    throw new SybaseBulkCopyError(`Bulk copy into ${options.table} failed: ${reason}. ${tail}.`, {
      rowsCommitted: committedRows,
      rowsInDoubt: doubt,
      batches: batches.slice(),
      rejected: byRow(rejected),
      rejectedCount,
      row: details.row,
      column: details.column,
      // As it is, not only as this failure left it: a commit before it may have
      // discarded the connection already.
      connectionDead: abandoned,
      cause: details.cause
    });
  };

  const recordRejects = (list: readonly SybaseBulkRejectedRow[], count: number): void => {
    rejectedCount += count;
    for (const item of list) {
      if (rejected.length < MAX_REJECTED_LISTED) {
        rejected.push(item);
      }
    }
  };

  // --- Open the copy ---
  let begun: NativeBulkBeginResult;
  // Checked on the clock before every native call: reading the caller's rows
  // may have run past the deadline before its timer could fire.
  if (io.checkDeadline()) {
    return fail("the deadline passed", { cause: io.deadlineError(), abandon: true });
  }
  try {
    begun = await io.race(
      io.begin({
        table: options.table,
        columns: options.columns,
        keepIdentity: options.keepIdentity,
        ignoreDefaults: options.ignoreDefaults,
        allowConstraintBypass: options.allowConstraintBypass,
        timeoutSeconds: options.timeoutSeconds
      })
    );
  } catch (err) {
    const failure = err as NativeBulkFailure;
    return fail(failure?.message ?? String(err), {
      cause: io.toCause(err),
      abandon: io.expired || failure?.reusable !== true
    });
  }

  // From here on every failure goes through `fail`: the copy is open.
  let reader: RowReader;
  try {
    const encoders = begun.columns.map(column => encoderFor(column, io.timeZone));
    reader = new RowReader(options.rows, begun.columns, encoders, maxErrors, () => {
      if (io.checkDeadline()) {
        throw io.deadlineError();
      }
    });
  } catch (err) {
    return fail(`reading the rows failed: ${messageOf(err)}`, {
      cause: err,
      abandon: true
    });
  }
  closeReader = () => reader.close();

  /** Rows read into the batch being planned (planning runs ahead of sending). */
  let planned = 0;
  const read = async (): Promise<Chunk | null> => {
    const chunk = await reader.next(Math.min(CHUNK_ROWS, batchSize - planned));
    if (chunk) {
      planned += chunk.inputRows;
      chunk.endsBatch = planned >= batchSize;
      if (chunk.endsBatch) {
        planned = 0;
      }
    }
    return chunk;
  };

  /**
   * Read the next chunk, settling rather than throwing: a read runs ahead while
   * the previous chunk is being sent, and its failure must not act — close the
   * connection — before that send has finished.
   */
  const readAhead = (): Promise<{ chunk: Chunk | null } | { error: unknown }> =>
    io.race(read()).then(
      chunk => ({ chunk }),
      (error: unknown) => ({ error })
    );

  /** The chunk read, or the copy's failure if reading failed. */
  const settleRead = (read: { chunk: Chunk | null } | { error: unknown }): Chunk | null => {
    if ("chunk" in read) {
      return read.chunk;
    }
    const err = read.error;
    // Rows refused before the read failed are still listed (and may themselves
    // be past the limit: that is then the failure reported).
    admitRefused(reader.takeRefused());
    if (io.expired) {
      return fail("the deadline passed", { cause: io.deadlineError(), abandon: true });
    }
    return fail(`reading the rows failed: ${messageOf(err)}`, {
      cause: err,
      abandon: true
    });
  };

  const send = async (
    payload: Chunk["payload"],
    rows: number,
    firstRow: number,
    commit: 0 | 1 | 2
  ): Promise<void> => {
    // Past the deadline the connection is closed (now, if the timer has not yet
    // run): nothing is sent after it.
    if (io.checkDeadline()) {
      return fail("the deadline passed", { cause: io.deadlineError(), abandon: true });
    }
    let result: NativeBulkSendResult;
    try {
      result = await io.race(
        io.send({
          ...payload,
          rows,
          firstRow,
          commit,
          maxRejects: Math.max(0, maxErrors - rejectedCount)
        })
      );
    } catch (err) {
      const failure = (typeof err === "object" && err !== null ? err : {}) as NativeBulkFailure;
      recordRejects(failure.rejected ?? [], failure.rejectedCount ?? 0);
      // A native failure says what this call committed, even when it failed
      // after committing (its deadline passed during the commit).
      const committedNow = typeof failure.committed === "number" ? failure.committed : 0;
      const sentNow = failure.rowsSent;
      openRows += sentNow ?? rows;
      if (committedNow > 0) {
        batches.push({ rows: committedNow });
        committedRows += committedNow;
        openRows = 0;
      }
      // The commit was under way and its answer was lost: the native side says
      // so when the connection broke; when the deadline passed here with the
      // call still running, it cannot be known either.
      // Without an `outcome` (the deadline passed with the call running, or
      // its answer could not be handed over) the commit is not known either.
      const inDoubt =
        committedNow === 0 &&
        commit !== COMMIT_NONE &&
        failure.outcome !== "none" &&
        failure.outcome !== "failed";
      return fail(failure.message ?? String(err), {
        cause: io.toCause(err),
        rowsInDoubt: inDoubt ? openRows : 0,
        row: failure.row,
        column: failure.column,
        abandon: true
      });
    }
    recordRejects(result.rejected, result.rejectedCount);
    openRows += result.rowsSent;
    if (commit !== COMMIT_NONE) {
      if (typeof result.committed !== "number") {
        // The commit's answer did not arrive in full: whether it committed
        // cannot be read off it.
        return fail("the server's answer to the commit could not be read", {
          rowsInDoubt: openRows,
          abandon: true
        });
      }
      const confirmed = result.committed;
      const sent = openRows;
      if (confirmed > 0) {
        batches.push({ rows: confirmed });
        committedRows += confirmed;
      }
      openRows = 0;
      if (confirmed !== sent) {
        fail(`the server reported ${confirmed} rows committed for a batch of ${sent} rows sent`, {
          abandon: true
        });
      }
    }
    if (result.discard) {
      // Committed, but the session could not be put back as it was (identity
      // insert, timeout): the connection must not be used again.
      abandon();
    }
  };

  /** Rows copied so far, as far as is known before the next commit. */
  const copiedSoFar = () => (maxErrors > 0 ? committedRows + openRows : readRows);

  /**
   * Fail before a commit that would break `expectedRows`: as soon as more rows
   * than expected are seen, and before the last commit if there are fewer.
   * Without `maxErrors` every row read is copied, so this runs before the rows
   * are sent; with it, once they are (the commit then goes in a call of its own).
   */
  const checkExpected = (total: number, last: boolean): void => {
    if (expected === undefined) {
      return;
    }
    if (total > expected) {
      fail(`expectedRows is ${expected}, but the input has more rows`, { abandon: true });
    }
    if (last && total !== expected) {
      fail(`expectedRows is ${expected}, but ${total} rows would be copied`, { abandon: true });
    }
  };

  /** Count rows the reader refused, failing past `maxErrors`: before their chunk is sent. */
  const admitRefused = (refused: readonly RefusedRow[]): void => {
    for (const { rejected: item, cause } of refused) {
      recordRejects([item], 1);
      if (rejectedCount > maxErrors) {
        fail(`row ${item.row}${item.column ? `, column '${item.column}'` : ""}: ${item.message}`, {
          cause,
          row: item.row,
          column: item.column,
          abandon: true
        });
      }
    }
  };

  const EMPTY = { text: "", lens: new Uint32Array(0) };

  let current = settleRead(await readAhead());
  if (current === null) {
    // Nothing to send: end the copy, so the connection can be used again.
    await send(EMPTY, 0, 1, COMMIT_DONE);
    if (expected !== undefined && expected !== 0) {
      fail(`expectedRows is ${expected}, but the input has no rows`, { abandon: false });
    }
    return {
      rowsCopied: 0,
      batches,
      rejected,
      rejectedCount,
      elapsedMs: Math.round(performance.now() - startedAt)
    };
  }
  // The read after `current`, running while `current` is sent (the native side
  // works on a worker thread). At most this one read is in flight.
  let pending: ReturnType<typeof readAhead> | null = readAhead();
  const takeNext = async (): Promise<Chunk | null> => {
    const next = settleRead(await pending!);
    pending = next ? readAhead() : null;
    return next;
  };

  while (current) {
    // Counted first: whatever happens to the reads after it — a failure, a
    // source that stalls — must not hide or delay what this chunk refused.
    admitRefused(current.refused);
    // A full batch is committed as soon as it is sent; a partial one has to
    // wait for the next read, to learn whether the input has ended. So does a
    // full one under expectedRows: if it is the last, the count must be checked
    // before it commits, not after.
    let next: Chunk | null | undefined;
    let commit: 0 | 1 | 2 = COMMIT_BATCH;
    // Known last (the reader has nothing more, as for TSV given whole): the
    // next read returns at once, and the batch is committed with the copy's
    // end — not followed by a round trip for an empty one.
    if (!current.endsBatch || expected !== undefined || reader.exhausted) {
      next = await takeNext();
      commit = next === null ? COMMIT_DONE : current.endsBatch ? COMMIT_BATCH : COMMIT_NONE;
    }
    const separateCommit = commit !== COMMIT_NONE && expected !== undefined && maxErrors > 0;
    if (maxErrors === 0) {
      checkExpected(readRows + current.inputRows, commit === COMMIT_DONE);
    }
    await send(
      current.payload,
      current.rows,
      current.firstRow,
      separateCommit ? COMMIT_NONE : commit
    );
    readRows += current.inputRows;
    // With maxErrors, how many rows are copied is known only once sent: more
    // than expected fails now, not after the rest has been read and sent too.
    if (maxErrors > 0 && !separateCommit) {
      checkExpected(copiedSoFar(), false);
    }
    if (separateCommit) {
      checkExpected(copiedSoFar(), commit === COMMIT_DONE);
      await send(EMPTY, 0, current.firstRow, commit);
    }
    if (next === undefined) {
      next = await takeNext();
      if (next === null) {
        // The input ended exactly at a batch boundary: end the copy, with an
        // empty last batch.
        checkExpected(copiedSoFar(), true);
        await send(EMPTY, 0, readRows + 1, COMMIT_DONE);
      }
    }
    current = next;
  }

  if (expected !== undefined && committedRows !== expected) {
    fail(`expectedRows is ${expected}, but the server reported ${committedRows} rows committed`, {
      abandon: false
    });
  }
  return {
    rowsCopied: committedRows,
    batches,
    rejected: byRow(rejected),
    rejectedCount,
    elapsedMs: Math.round(performance.now() - startedAt)
  };
};

/** Rejected rows in input order: a chunk's are found by the reader and by the native side. */
const byRow = (list: SybaseBulkRejectedRow[]): SybaseBulkRejectedRow[] =>
  list.slice().sort((a, b) => a.row - b.row);
