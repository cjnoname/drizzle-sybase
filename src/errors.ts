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

  constructor(message: string, operation: "connect" | "query" | "acquire", timeoutMs: number) {
    // Only connect timeout implies a dead connection;
    // query/acquire timeouts don't mean the connection is dead
    super(message, operation === "connect");
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
