/**
 * Sybase error hierarchy.
 *
 * Provides fine-grained error types for different failure modes:
 * - SybaseError: Base error class for all Sybase-related errors
 * - SybaseConnectionError: Connection establishment/loss failures
 * - SybaseQueryError: SQL execution errors (syntax, permissions, etc.)
 * - SybaseTimeoutError: Operation timeout errors
 * - SybasePoolError: Connection pool errors (exhausted, closed, etc.)
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

/**
 * Base error class for all drizzle-sybase errors.
 *
 * All Sybase-specific errors extend this class, allowing catch-all handling:
 * ```ts
 * try {
 *   await db.execute(sql`...`);
 * } catch (err) {
 *   if (err instanceof SybaseError) {
 *     // Handle any Sybase error
 *   }
 * }
 * ```
 */
/**
 * The message of what was thrown — whatever was thrown: its `message` if it has
 * one, else `fallback`, else its string form — the addon rejects with
 * `undefined` when even an Error cannot be made (out of memory), and a source
 * of rows may throw anything. Never throws itself (a value with no string
 * form, like `Object.create(null)`, gives its tag instead).
 *
 * @internal
 */
export const messageOf = (err: unknown, fallback?: string): string => {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string") {
    return message;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
};

export class SybaseError extends Error {
  /** Whether the underlying connection is dead and needs replacement. */
  readonly connectionDead: boolean;

  /** Optional Sybase server message number. */
  readonly msgNo?: number;

  /** Optional Sybase severity level. */
  readonly severity?: number;

  constructor(message: string, connectionDead = false) {
    super(message);
    this.name = "SybaseError";
    this.connectionDead = connectionDead;

    // Parse Sybase error message format: "Msg N, Level N, State N..."
    const msgMatch = message.match(/Msg\s+(\d+)/);
    if (msgMatch) {
      this.msgNo = Number(msgMatch[1]);
    }
    const levelMatch = message.match(/Level\s+(\d+)/);
    if (levelMatch) {
      this.severity = Number(levelMatch[1]);
    }
  }
}

// ---------------------------------------------------------------------------
// Connection errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when a connection cannot be established or has died.
 *
 * Common causes:
 * - Invalid host/port
 * - Authentication failure
 * - Network timeout
 * - Server unreachable
 * - Connection dropped by server
 */
export class SybaseConnectionError extends SybaseError {
  /** The host that was being connected to. */
  readonly host?: string;

  /** The port that was being connected to. */
  readonly port?: number;

  constructor(message: string, options?: { host?: string; port?: number }) {
    super(message, true);
    this.name = "SybaseConnectionError";
    this.host = options?.host;
    this.port = options?.port;
  }
}

// ---------------------------------------------------------------------------
// Query errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when a SQL query fails execution.
 *
 * Common causes:
 * - Syntax errors
 * - Object not found (table, column, procedure)
 * - Permission denied
 * - Constraint violations (unique, foreign key, check)
 * - Data type conversion errors
 */
export class SybaseQueryError extends SybaseError {
  /** The SQL that caused the error (may be truncated for security). */
  readonly sql?: string;

  constructor(message: string, options?: { sql?: string; connectionDead?: boolean }) {
    super(message, options?.connectionDead ?? false);
    this.name = "SybaseQueryError";
    // Truncate SQL to avoid leaking large queries into logs
    this.sql = options?.sql ? options.sql.slice(0, 200) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Timeout errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when an operation exceeds its configured timeout.
 *
 * May be thrown for:
 * - Connection establishment timeout
 * - Query execution timeout
 * - Pool acquire timeout
 */
export class SybaseTimeoutError extends SybaseError {
  /** The timeout value in milliseconds that was exceeded. */
  readonly timeoutMs: number;

  /** The type of operation that timed out. */
  readonly operation: "connect" | "query" | "acquire";

  /**
   * @param connectionDead Whether the timeout left the connection unusable (it
   *   was closed). Default: only for `connect`. A query's hard timeout closes
   *   its connection; its cooperative timeout usually does not.
   */
  constructor(
    message: string,
    operation: "connect" | "query" | "acquire",
    timeoutMs: number,
    connectionDead: boolean = operation === "connect"
  ) {
    super(message, connectionDead);
    this.name = "SybaseTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Pool errors
// ---------------------------------------------------------------------------

/**
 * Error thrown for connection pool-specific failures.
 *
 * Common causes:
 * - Pool is closed
 * - Pool is draining
 * - All connections exhausted and acquire timeout reached
 */
export class SybasePoolError extends SybaseError {
  /** Current pool state when the error occurred. */
  readonly poolState?: "closed" | "draining" | "exhausted";

  constructor(message: string, poolState?: "closed" | "draining" | "exhausted") {
    super(message, false);
    this.name = "SybasePoolError";
    this.poolState = poolState;
  }
}

// ---------------------------------------------------------------------------
// Bulk copy errors
// ---------------------------------------------------------------------------

/** One committed batch of a bulk copy: the row count the server reported for it. */
export interface SybaseBulkBatch {
  /** Rows the server reported committed by this batch. */
  rows: number;
}

/** A row a bulk copy left out because one of its values could not be converted. */
export interface SybaseBulkRejectedRow {
  /** 1-based number of the row in the input (TSV: its line). */
  row: number;
  /** The column whose value was refused; absent when the row as a whole was. */
  column?: string;
  /** Why it was refused. */
  message: string;
}

/**
 * A bulk copy that failed, and exactly what it left behind.
 *
 * Batches the server confirmed before the failure stay committed —
 * {@link rowsCommitted} and {@link batches} say how many rows that is. The
 * batch that was open when it failed is rolled back, except in one case: when
 * the connection was lost (or the deadline passed) while the server was
 * committing it, the answer never arrived, and {@link rowsInDoubt} rows may or
 * may not have been committed. Only then does the caller have to look.
 *
 * {@link cause} holds the underlying error: a `SybaseTimeoutError` for a
 * timeout, a `SybaseConnectionError` for a lost connection, a
 * `SybaseQueryError` for a server error such as a duplicate key, a `TypeError`
 * for a value that cannot be converted.
 */
/**
 * What a bulk copy failed on:
 * - `refused`: the rows — a value that does not convert, a NULL for a NOT NULL
 *   column, more refused rows than `maxErrors`, a count other than
 *   `expectedRows`. Sending them again fails again.
 * - `source`: the caller's rows could not be read (the source threw, or is not
 *   rows at all).
 * - `server`: the server refused the copy or a batch (a duplicate key, a
 *   permission, a table with triggers, a transaction open, ...).
 * - `connection`: the connection was lost, or the answer to a commit.
 * - `timeout`: a timeout of the call passed.
 */
export type SybaseBulkFailureKind = "refused" | "source" | "server" | "connection" | "timeout";

export class SybaseBulkCopyError extends SybaseError {
  /** What the copy failed on; see {@link SybaseBulkFailureKind}. */
  readonly kind: SybaseBulkFailureKind;

  /**
   * Whether the same copy may succeed if tried again: a lost connection, a
   * timeout, or a deadlock the server chose this copy to end. Never for rows
   * that were refused. (`connectionDead` says nothing of this: a failed copy is
   * always abandoned by closing its connection, which is what rolls back its
   * open batch.) What to send again is the caller's to work out:
   * `rowsCommitted` are in the table, and `rowsInDoubt` may be.
   */
  readonly retryable: boolean;

  /** Rows committed by earlier batches — certainly in the table. */
  readonly rowsCommitted: number;

  /**
   * Rows whose commit was under way when the answer was lost; 0 in every other
   * case. When the deadline passed with the call still running (or its answer
   * could not be read), how far it got is not known either: this is then an
   * upper bound — every row of the batch, those of that call included.
   */
  readonly rowsInDoubt: number;

  /** The batches committed before the failure, in order. */
  readonly batches: SybaseBulkBatch[];

  /** Rows left out before the failure (only with `maxErrors`), at most 1000 listed, in the order they were found. */
  readonly rejected: SybaseBulkRejectedRow[];

  /**
   * How many rows were left out before the failure: all of them, listed or not
   * — as far as known: rows refused in a call whose answer was lost (see
   * {@link rowsInDoubt}) are not counted.
   */
  readonly rejectedCount: number;

  /** 1-based input row the copy failed on, when it failed on a row. */
  readonly row?: number;

  /** Column the copy failed on, when it failed on a value. */
  readonly column?: string;

  constructor(
    message: string,
    details: {
      rowsCommitted: number;
      rowsInDoubt: number;
      batches: SybaseBulkBatch[];
      rejected: SybaseBulkRejectedRow[];
      /** Default: as many as `rejected` lists. */
      rejectedCount?: number;
      row?: number;
      column?: string;
      connectionDead: boolean;
      kind: SybaseBulkFailureKind;
      cause?: unknown;
    }
  ) {
    super(message, details.connectionDead);
    this.name = "SybaseBulkCopyError";
    this.kind = details.kind;
    this.retryable =
      details.kind === "connection" ||
      details.kind === "timeout" ||
      (details.kind === "server" &&
        (details.cause as { msgNo?: unknown } | undefined)?.msgNo === 1205);
    this.rowsCommitted = details.rowsCommitted;
    this.rowsInDoubt = details.rowsInDoubt;
    this.batches = details.batches;
    this.rejected = details.rejected;
    this.rejectedCount = details.rejectedCount ?? details.rejected.length;
    this.row = details.row;
    this.column = details.column;
    if (details.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: details.cause,
        enumerable: false,
        writable: true,
        configurable: true
      });
    }
  }
}
