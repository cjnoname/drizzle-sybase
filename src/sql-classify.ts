/**
 * What a raw SQL batch may do, read from its text alone.
 *
 * Used to decide whether a statement can be retried, whether the session needs
 * resetting before a pooled connection is reused, and what may run inside a
 * managed transaction. Every classifier errs on the safe side: literals,
 * quoted identifiers and comments are removed first so their content cannot
 * match, and text that cannot be tokenized is treated as the risky case.
 */

/** Keywords that can change data, schema, or session/transaction state. */
const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|into|exec|execute|create|alter|drop|truncate|grant|revoke|begin|commit|rollback|save|declare|writetext|dump|load|dbcc|kill|shutdown|reconfigure|use|setuser)\b/;

/**
 * The code of a batch with literals, quoted identifiers and comments blanked
 * out, or `null` when the batch cannot be tokenized reliably.
 *
 * A scanner rather than a regex because ASE block comments nest: in
 * `/* a /* b *\/ ' *\/ delete from t`, the server sees one comment ending
 * at the second `*\/` and then runs the DELETE. A regex closing the comment at
 * the first `*\/` would read `' *\/ ... '` as a string literal and hide it.
 * Anything left unterminated returns `null`, which callers must treat as
 * "unknown".
 */
const QUOTE = 39; // '
const DOUBLE_QUOTE = 34; // "
const BRACKET = 91; // [
const DASH = 45; // -
const SLASH = 47; // /
const STAR = 42; // *

const codeOnly = (sql: string): string | null => {
  // Scans char codes and copies the code between literals and comments in
  // slices; literals and comments themselves are skipped with indexOf.
  const parts: string[] = [];
  let segment = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql.charCodeAt(i);
    let end: number;
    if (c === QUOTE || c === DOUBLE_QUOTE || c === BRACKET) {
      const close = c === BRACKET ? "]" : sql[i];
      end = i + 1;
      for (;;) {
        end = sql.indexOf(close, end);
        if (end === -1) {
          return null;
        }
        // A doubled closing character is an escaped one, not the end.
        if (sql[end + 1] === close) {
          end += 2;
          continue;
        }
        end++;
        break;
      }
    } else if (c === DASH && sql.charCodeAt(i + 1) === DASH) {
      end = sql.indexOf("\n", i);
      if (end === -1) {
        end = sql.length;
      }
    } else if (c === SLASH && sql.charCodeAt(i + 1) === STAR) {
      let depth = 1;
      end = i + 2;
      while (depth > 0) {
        const closeAt = sql.indexOf("*/", end);
        if (closeAt === -1) {
          return null;
        }
        const open = sql.indexOf("/*", end);
        if (open !== -1 && open < closeAt) {
          depth++;
          end = open + 2;
        } else {
          depth--;
          end = closeAt + 2;
        }
      }
    } else {
      i++;
      continue;
    }
    parts.push(sql.slice(segment, i), " ");
    i = end;
    segment = end;
  }
  parts.push(sql.slice(segment));
  return parts.join("").toLowerCase();
};

/**
 * Whether `sql` is safe to re-run after a connection died mid-statement.
 *
 * Conservative by design — a false "no" only skips a retry, a false "yes" could
 * repeat a write. Accepts `select` batches, optionally
 * wrapped in `SET ROWCOUNT` (a common raw-SQL way to cap rows). Literals,
 * quoted identifiers and comments are removed first (see {@link codeOnly}) so
 * their content cannot match; any write keyword or other `SET` option anywhere
 * rejects the batch, as does anything that cannot be tokenized.
 *
 * @internal
 */
export const isReadOnlySql = (sql: string): boolean => {
  const code = codeOnly(sql);
  if (code === null) {
    return false;
  }
  if (!/^\s*(select|set\s+rowcount)\b/.test(code)) {
    return false;
  }
  if (WRITE_KEYWORDS.test(code)) {
    return false;
  }
  // `SET ROWCOUNT` is the only session option allowed.
  return !/\bset\s+(?!rowcount\b)/.test(code);
};

/**
 * Statements that can leave a transaction open or change the session state
 * the pool resets: transaction control, procedures (which may do either), and
 * the `SET` options {@link SybaseConnection.resetSessionState} covers.
 */
const STATE_CHANGING =
  /\b(begin\s+tran(saction)?|save\s+tran(saction)?|commit|rollback|exec|execute|use|setuser)\b|\bset\s+(rowcount|chained|transaction)\b/;

/**
 * Words a batch can start with that are not a procedure name. ASE runs a
 * batch whose first word is anything else as `exec <word>`.
 */
const KEYWORD_START =
  /^\s*(select|insert|update|delete|truncate|create|drop|alter|declare|if|while|begin|set|print|raiserror|waitfor|grant|revoke|dbcc|checkpoint|dump|load|readtext|writetext|commit|rollback|save|exec|execute|use|setuser|return|kill|reconfigure|open|fetch|close|deallocate|lock)\b/;

/**
 * Whether a batch that succeeded may have left the session in a state that
 * must not reach the next user of a pooled connection — an open transaction,
 * chained mode, a ROWCOUNT, another isolation level.
 *
 * Conservative like {@link isReadOnlySql}: a false "yes" costs one round-trip
 * to reset the session, a false "no" could hand someone else an open
 * transaction. Anything that cannot be tokenized counts as "yes".
 *
 * Text cannot prove a reset will run — `SET ROWCOUNT 0` at the end of a batch
 * is skipped by an earlier `RETURN` or error — so no batch is exempt. (The
 * select builder paginates with `TOP`, so its SQL never sets any of this.)
 *
 * @internal
 */
export const mayLeaveSessionState = (sql: string): boolean => {
  const code = codeOnly(sql);
  return code === null || !KEYWORD_START.test(code) || STATE_CHANGING.test(code);
};

/**
 * Whether a batch may have created a `#temp` table, which outlives the batch
 * and would reach the next user of a pooled connection. Every such name
 * contains `#` and cannot be quoted, so a batch without one creates none
 * (tables created inside a procedure or `exec()` are dropped when it returns).
 * A `#` inside a literal only costs a needless check.
 *
 * @internal
 */
export const mayCreateTempTable = (sql: string): boolean => sql.includes("#");

/**
 * Whether a batch explicitly ends a transaction: a `COMMIT`, or a `ROLLBACK`
 * that names no savepoint. Inside a managed transaction such a batch is
 * refused before it is sent — checking afterwards is too late, because the
 * statements following it in the same batch have already run in autocommit.
 * `ROLLBACK TRAN <name>` (to a savepoint) is allowed; the transaction is still
 * checked after every statement that could end it, which also catches a
 * procedure that commits internally.
 *
 * @internal
 */
export const endsTransaction = (sql: string): boolean => {
  const code = codeOnly(sql);
  if (code === null) {
    // Cannot be tokenized: the server will reject it anyway.
    return false;
  }
  return (
    /\bcommit\b/.test(code) ||
    /\brollback\b(?!\s+tran(saction)?\s+(?!(work|select|insert|update|delete|exec|execute|commit|rollback|begin|end|if|else|while|set|declare|print|return|create|drop|alter|truncate|save|waitfor|raiserror|use|dump|load)\b)[a-z_@#$][\w@#$]*)/.test(
      code
    )
  );
};

/**
 * Whether a batch may switch the session's identity (`setuser`). Unlike the
 * rest of the session state there is no restoring it to a known baseline —
 * the original identity may lack the permission to switch back — so a
 * connection that ran one is discarded rather than reused.
 *
 * @internal
 */
export const mayChangeIdentity = (sql: string): boolean => {
  const code = codeOnly(sql);
  return code === null || /\bsetuser\b/.test(code);
};
