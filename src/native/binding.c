/**
 * FreeTDS db-lib N-API native addon — production-grade implementation.
 *
 * Design notes / bug fixes vs. earlier revisions:
 *   - Per-connection query timeout via `dbsetopt(DBSETTIME)` instead of the
 *     process-global `dbsettime()`. Same for login timeout: we serialize
 *     `dbsetlogintime()` with a mutex around `dbopen()` so concurrent
 *     connects with different timeouts don't race.
 *   - err_handler returns INT_CANCEL only for fatal errors and INT_TIMEOUT
 *     for SYBETIME so the user-supplied DBSETTIME drives cancellation cleanly.
 *   - DBSETLPACKET is set on every login to avoid the 512-byte default,
 *     which causes excessive round-trips on large result sets.
 *   - Hard timeout watchdog: every async query spawns a uv_thread_t that, after
 *     `hardTimeoutMs` (default 2 * timeout_seconds, min 30s) signals the JS
 *     layer that the query has missed its deadline. The watchdog REJECTS the
 *     pending promise immediately (via a threadsafe function) and marks the
 *     connection dead so the pool discards it.
 *
 *     The watchdog deliberately does NOT call dbcancel() from its thread:
 *     dbcancel() invokes tds_process_cancel() which reads from the same
 *     socket the worker is reading from, racing with the worker's own
 *     dbnextrow(). We rely on db-lib's per-connection DBSETTIME to actually
 *     unblock the worker, which then exits naturally; the worker's late
 *     return is discarded since the promise was already rejected.
 *   - Deferred close: fn_close detects in-flight queries (via in_flight
 *     counter) and instead of freeing immediately, sets pending_close.
 *     conn_release in the worker performs the actual destruction, eliminating
 *     the use-after-free that would otherwise happen when the JS layer
 *     abandons a stuck connection.
 *   - Concurrency self-protection: conn_acquire rejects re-entry while
 *     another query is in flight on the same connection — db-lib's DBPROCESS
 *     is not reentrant, and JS-side serialization can be bypassed.
 *   - All db-lib calls run on libuv worker threads via napi_create_async_work
 *     so the JS event loop is never blocked.
 *   - Per-connection error buffer (handlers locate it via dbgetuserdata).
 *   - maxRows protection, full memory cleanup on every error path.
 *
 * Operational note:
 *   The libuv worker pool is shared (default size 4). If a worker is stuck
 *   in db-lib I/O until DBSETTIME fires, that slot is unavailable. For
 *   high-concurrency workloads, set UV_THREADPOOL_SIZE to a value at least
 *   equal to your max pool size.
 */
#include <node_api.h>
#include <sybfront.h>
#include <sybdb.h>
#include <uv.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Maximum error message size we'll capture per connection.
#define ERR_BUF_SIZE 4096
// Maximum rows to return by default (safety limit against accidental OOM).
#define DEFAULT_MAX_ROWS 1000000
// Default TDS network packet size (bytes): ASE's out-of-the-box `max network
// packet size`. The server does not negotiate a larger request down — it
// refuses the login (Msg 4002, as for a bad password) — so the default is the
// stock limit; a server configured lower (down to 512) needs packetSize set.
#define DEFAULT_PACKET_SIZE 2048

// ---------------------------------------------------------------------------
// Global mutex for serializing inherently process-wide db-lib calls.
//
// `dbsetlogintime()` is process-global in FreeTDS. We hold this mutex from
// the moment we set the login timeout until dbopen() returns, so concurrent
// connects with different timeouts never see each other's value.
// ---------------------------------------------------------------------------

static uv_once_t global_init_once = UV_ONCE_INIT;
static uv_mutex_t login_mutex;

/*
 * Messages raised while dbopen() runs. The handlers find a connection through
 * the DBPROCESS's user data, which does not exist until dbopen() returns, so
 * without this every login failure — bad password, unknown database, a packet
 * size the server refuses — surfaced only as "Failed to connect".
 *
 * Thread-local, not guarded by login_mutex: db-lib calls the handlers on the
 * thread that made the call, so a thread's login messages are exactly what its
 * own dbopen() raised. A shared buffer would also collect errors other threads
 * raise with no DBPROCESS (db-lib reports e.g. allocation failures that way)
 * — racing on the buffer and blaming the wrong login.
 */
#if defined(_MSC_VER)
#define THREAD_LOCAL __declspec(thread)
#else
#define THREAD_LOCAL _Thread_local
#endif
static THREAD_LOCAL char login_error[ERR_BUF_SIZE];
static THREAD_LOCAL int login_in_progress = 0;

static void append_login_error(const char *fmt, ...) {
  if (!login_in_progress) {
    return;
  }
  size_t used = strlen(login_error);
  if (used + 1 >= sizeof(login_error)) {
    return;
  }
  va_list args;
  va_start(args, fmt);
  vsnprintf(login_error + used, sizeof(login_error) - used, fmt, args);
  va_end(args);
}

static void init_globals(void) {
  uv_mutex_init(&login_mutex);
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

/**
 * Connection wrapper — holds the DBPROCESS plus error state.
 *
 * The error/message handlers locate this struct via dbgetuserdata() and
 * write error text into it. The query function checks has_error after each
 * db-lib call.
 *
 * `dead` is set:
 *   - by err_handler when DBDEAD() reports the connection is gone, or
 *   - by the watchdog thread when it had to force-cancel a runaway query.
 *
 * Lifetime / free safety:
 *   `lock` guards `in_flight` and `pending_close`. fn_close decrements
 *   nothing, but if in_flight > 0 it sets pending_close and returns without
 *   freeing — the worker (or watchdog) that decrements in_flight to zero
 *   is then responsible for the actual dbclose+free. This prevents the JS
 *   layer from racing a hard-timeout close against a still-running worker
 *   that is mid-`dbnextrow()` (would otherwise be use-after-free).
 */
typedef struct {
  DBPROCESS *dbproc;
  LOGINREC *login;
  char last_error[ERR_BUF_SIZE];
  int has_error;
  int dead;
  int timed_out;        // set when err_handler sees SYBETIME
  int timeout_seconds;  // remembered so watchdog can compute its deadline
  uv_mutex_t lock;
  int in_flight;        // # of queries pinning this connection, from enqueue to completion
  int pending_close;    // 1 if fn_close was called while in_flight > 0
  // 1 when the server's character set is iso_1: its single-byte
  // text is Latin-1, decoded to UTF-8 on the way in and encoded on the way out.
  // Fixed once the connection is open; see detect_server_charset.
  int latin1;
  // The server's default character set name, as syscharsets spells it.
  char charset[32];
} SybaseConnection;

// Forward declarations.
static void destroy_connection(SybaseConnection *conn);

/**
 * Mark a query as starting on the connection. Returns 0 on success, -1 if
 * the connection is already closed or has a pending close.
 */
static int conn_acquire(SybaseConnection *conn) {
  uv_mutex_lock(&conn->lock);
  if (conn->pending_close || conn->dbproc == NULL) {
    uv_mutex_unlock(&conn->lock);
    return -1;
  }
  conn->in_flight++;
  uv_mutex_unlock(&conn->lock);
  return 0;
}

/**
 * Mark a query as finished. If a close was pending and this was the last
 * in-flight query, performs the deferred dbclose + free here.
 */
static void conn_release(SybaseConnection *conn) {
  uv_mutex_lock(&conn->lock);
  conn->in_flight--;
  int should_destroy = (conn->in_flight == 0 && conn->pending_close);
  uv_mutex_unlock(&conn->lock);

  if (should_destroy) {
    destroy_connection(conn);
  }
}

/**
 * `dead` is written by the worker (err_handler), the watchdog thread and the
 * JS thread (fn_close), so every access goes through `conn->lock`.
 */
static void conn_mark_dead(SybaseConnection *conn) {
  uv_mutex_lock(&conn->lock);
  conn->dead = 1;
  uv_mutex_unlock(&conn->lock);
}

static int conn_is_dead(SybaseConnection *conn) {
  uv_mutex_lock(&conn->lock);
  int dead = conn->dead;
  uv_mutex_unlock(&conn->lock);
  return dead;
}

/**
 * Actually free a connection. Must be called outside conn->lock; this
 * function destroys the lock itself.
 */
static void destroy_connection(SybaseConnection *conn) {
  if (conn->dbproc) {
    dbclose(conn->dbproc);
    conn->dbproc = NULL;
  }
  if (conn->login) {
    dbloginfree(conn->login);
    conn->login = NULL;
  }
  uv_mutex_destroy(&conn->lock);
  free(conn);
}

/**
 * Close a connection now, or — if a query is still running on it — mark it
 * so the last worker to finish frees it (see conn_release).
 */
static void close_connection(SybaseConnection *conn) {
  uv_mutex_lock(&conn->lock);
  int can_destroy_now = (conn->in_flight == 0);
  int already_pending = conn->pending_close;
  conn->pending_close = 1;
  conn->dead = 1;  // reject any subsequent acquire
  uv_mutex_unlock(&conn->lock);

  if (can_destroy_now && !already_pending) {
    destroy_connection(conn);
  }
  // else: the worker holding in_flight frees it in conn_release.
}

// ---------------------------------------------------------------------------
// JS-facing connection handle
//
// JS holds an external pointing at this box, never at the connection itself:
// the connection is freed on close, but the external lives on for as long as
// JS keeps a reference. Clearing `conn` on close makes every later use of the
// handle — a second close, isAlive, query — see a closed connection instead of
// freed memory. Only the JS thread touches the box, so it needs no lock.
// ---------------------------------------------------------------------------

typedef struct {
  SybaseConnection *conn;  // NULL once closed
} ConnHandle;

// Identifies externals created by connect(), so an arbitrary value passed as a
// handle is rejected rather than dereferenced.
static const napi_type_tag CONN_HANDLE_TAG = {0x8f1c2a7d3b4e5f60ULL, 0x91a2b3c4d5e6f708ULL};

/** GC of a handle that was never closed: close the connection it still owns. */
static void conn_handle_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  ConnHandle *handle = (ConnHandle *)data;
  if (handle->conn) {
    close_connection(handle->conn);
    handle->conn = NULL;
  }
  free(handle);
}

/**
 * The handle behind `value`, or NULL (with a TypeError thrown) if `value` is
 * not one returned by connect().
 */
static ConnHandle *get_conn_handle(napi_env env, napi_value value) {
  bool tagged = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, value, &CONN_HANDLE_TAG, &tagged) != napi_ok || !tagged ||
      napi_get_value_external(env, value, &data) != napi_ok || data == NULL) {
    napi_throw_type_error(env, NULL, "Expected a connection handle returned by connect()");
    return NULL;
  }
  return (ConnHandle *)data;
}

// ---------------------------------------------------------------------------
// Error/message handlers
//
// These are installed once globally in module init. They route per-connection
// state via dbgetuserdata().
// ---------------------------------------------------------------------------

/**
 * Latin-1 bytes as UTF-8: one code point per byte, so it cannot fail and loses
 * nothing. `out` needs room for 2 bytes per input byte. Returns the length.
 */
static size_t latin1_to_utf8(const unsigned char *in, size_t n, unsigned char *out) {
  size_t len = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char b = in[i];
    if (b < 0x80) {
      out[len++] = b;
    } else {
      out[len++] = (unsigned char)(0xC0 | (b >> 6));
      out[len++] = (unsigned char)(0x80 | (b & 0x3F));
    }
  }
  return len;
}

/** `text` as a new NUL-terminated string, decoded from Latin-1 when `latin1` is set. */
static char *dup_text(const char *text, int latin1) {
  if (!latin1) {
    return strdup(text);
  }
  size_t n = strlen(text);
  char *out = (char *)malloc(n * 2 + 1);
  if (out) {
    out[latin1_to_utf8((const unsigned char *)text, n, (unsigned char *)out)] = '\0';
  }
  return out;
}

static int err_handler(DBPROCESS *dbproc, int severity, int dberr,
                       int oserr, char *dberrstr, char *oserrstr) {
  (void)oserr;
  (void)oserrstr;

  SybaseConnection *conn = NULL;
  if (dbproc) {
    conn = (SybaseConnection *)dbgetuserdata(dbproc);
  }

  if (!conn) {
    // During dbopen there is no connection to attach it to yet.
    append_login_error("DB-Lib error %d (severity %d): %s\n", dberr, severity, dberrstr);
  }

  if (conn) {
    size_t cur_len = strlen(conn->last_error);
    if (cur_len < ERR_BUF_SIZE - 100) {
      snprintf(conn->last_error + cur_len, ERR_BUF_SIZE - cur_len,
               "DB-Lib error %d (severity %d): %s\n", dberr, severity, dberrstr);
    }
    conn->has_error = 1;

    if (dberr == SYBETIME) {
      conn->timed_out = 1;
    }

    if (DBDEAD(dbproc)) {
      conn_mark_dead(conn);
    }
  }

  // For the per-connection DBSETTIME firing, return INT_TIMEOUT so db-lib
  // sends a cancel and does not loop. For all other fatal errors, INT_CANCEL.
  if (dberr == SYBETIME) {
    return INT_TIMEOUT;
  }
  return INT_CANCEL;
}

static int msg_handler(DBPROCESS *dbproc, DBINT msgno, int msgstate,
                       int severity, char *msgtext, char *srvname,
                       char *procname, int line) {
  (void)msgstate;
  (void)srvname;
  (void)procname;
  (void)line;

  // Severity <= 10 = informational (e.g. "Changed database context to ...")
  if (severity <= 10) {
    return 0;
  }

  SybaseConnection *conn = NULL;
  if (dbproc) {
    conn = (SybaseConnection *)dbgetuserdata(dbproc);
  }

  if (!conn) {
    append_login_error("Msg %ld, Level %d, State %d: %s\n", (long)msgno, severity, msgstate,
                       msgtext);
  }

  if (conn) {
    size_t cur_len = strlen(conn->last_error);
    if (cur_len < ERR_BUF_SIZE - 200) {
      // Server messages quote names and values in the server's character set.
      char *text = dup_text(msgtext ? msgtext : "", conn->latin1);
      snprintf(conn->last_error + cur_len, ERR_BUF_SIZE - cur_len,
               "Msg %ld, Level %d, State %d: %s\n",
               (long)msgno, severity, msgstate, text ? text : msgtext);
      free(text);
    }
    conn->has_error = 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static void clear_error(SybaseConnection *conn) {
  conn->last_error[0] = '\0';
  conn->has_error = 0;
  conn->timed_out = 0;
}

/**
 * How a column's values are stored on the worker thread and handed to JS.
 *
 * Results are kept column by column, in the representation JS receives, so
 * that the JS thread does one call per column instead of several per cell:
 * fixed-width values are decoded from db-lib's binary form here and copied to
 * JS as one typed array; text is packed back to back and crosses as a few large
 * strings that JS splits.
 */
typedef enum {
  KIND_TEXT,       // UTF-8 text, each value followed by a NUL separator
  KIND_BINARY,     // raw bytes, back to back, for JS to cut into one Buffer per value
  KIND_INT32,      // tinyint, smallint, int
  KIND_FLOAT64,    // float, real, usmallint, uint
  KIND_INT64,      // bigint
  KIND_UINT64,     // ubigint
  KIND_BOOL,       // bit
  KIND_WALLCLOCK,  // datetime, smalldatetime: the wall clock as ms since 1970, read as UTC
} ValueKind;

/** The `kind` JS sees for each ValueKind. */
static const char *const KIND_NAMES[] = {"text",  "binary", "int32", "float64",
                                         "int64", "uint64", "bool",  "wallclock"};

/** Bytes per value of a fixed-width kind; 0 for text and binary. */
static size_t kind_size(ValueKind kind) {
  switch (kind) {
    case KIND_INT32:
      return sizeof(int32_t);
    case KIND_FLOAT64:
    case KIND_WALLCLOCK:
      return sizeof(double);
    case KIND_INT64:
      return sizeof(int64_t);
    case KIND_UINT64:
      return sizeof(uint64_t);
    case KIND_BOOL:
      return 1;
    default:
      return 0;
  }
}

typedef struct {
  char *name;
  int type;
  ValueKind kind;
  // Single-byte text in the server's Latin-1, to decode (see SybaseConnection.latin1).
  int latin1;
  // One byte per row, 1 where the value is NULL.
  unsigned char *nulls;
  int has_nulls;
  // Fixed-width kinds: one value per row (0 where NULL).
  unsigned char *fixed;
  // Text and binary: the values back to back, and the offset just past each
  // one. Text is always valid UTF-8 here (see store_text), and may hold NULs.
  char *bytes;
  size_t bytes_len;
  size_t bytes_cap;
  size_t *ends;
  // Text: each value's length in UTF-16 code units, which is how JS cuts a run
  // of values back into one string per value.
  uint32_t *units;
} ResultColumn;

/** Whether a column carries raw bytes, handed to JS as a Buffer. */
static int is_binary_type(int coltype) {
  return coltype == SYBBINARY || coltype == SYBVARBINARY || coltype == SYBIMAGE;
}

/**
 * Discard the rest of the current result set. dbnextrow() returns FAIL — and
 * keeps returning it — once the connection is dead, so a bare
 * `while (dbnextrow() != NO_MORE_ROWS)` would spin forever on a broken
 * stream. Returns FAIL in that case so the caller can bail out.
 */
static RETCODE discard_rows(DBPROCESS *dbproc) {
  RETCODE rc;
  while ((rc = dbnextrow(dbproc)) != NO_MORE_ROWS) {
    if (rc == FAIL) {
      return FAIL;
    }
  }
  return SUCCEED;
}

/*
 * ASE's unsigned integer types. db-lib defines no names for them, so they reach
 * `dbcoltype` as their TDS type codes — the same code whether or not the column
 * is nullable (checked against ASE 15.7).
 */
#define TDS_USMALLINT 65
#define TDS_UINT 66
#define TDS_UBIGINT 67
/* Nullable variant, as computed expressions report it; the size says which. */
#define TDS_UINTN 68

/** `dbcoltype`, with the nullable unsigned variant resolved by size like db-lib does for the rest. */
static int column_type(DBPROCESS *dbproc, int column) {
  int type = dbcoltype(dbproc, column);
  if (type != TDS_UINTN) {
    return type;
  }
  switch (dbcollen(dbproc, column)) {
    case 2:
      return TDS_USMALLINT;
    case 4:
      return TDS_UINT;
    case 8:
      return TDS_UBIGINT;
    default:
      return type;
  }
}

/**
 * Sybase system type name for a db-lib column type, using the same spelling as
 * the schema/introspection layer. Exposed to JS as `columnTypes` so callers can
 * decode by type — for a raw query with no schema attached, the column type is
 * the only thing that says a value is a timestamp rather than text that happens
 * to look like one.
 *
 * `dbcoltype` reports the concrete type, never the nullable `*N` variants
 * (db-lib resolves SYBDATETIMN to SYBDATETIME/SYBDATETIME4 by size), so those
 * need no cases here.
 */
static const char *syb_type_name(int coltype) {
  switch (coltype) {
    case TDS_USMALLINT:
      return "usmallint";
    case TDS_UINT:
      return "uint";
    case TDS_UBIGINT:
      return "ubigint";
    default:
      break;
  }
  switch (coltype) {
    case SYBINT1:
      return "tinyint";
    case SYBINT2:
      return "smallint";
    case SYBINT4:
      return "int";
    case SYBINT8:
      return "bigint";
    case SYBFLT8:
      return "float";
    case SYBREAL:
      return "real";
    case SYBMONEY:
      return "money";
    case SYBMONEY4:
      return "smallmoney";
    case SYBNUMERIC:
      return "numeric";
    case SYBDECIMAL:
      return "decimal";
    case SYBBIT:
      return "bit";
    case SYBDATETIME:
      return "datetime";
    case SYBDATETIME4:
      return "smalldatetime";
    case SYBDATE:
      return "date";
    case SYBTIME:
      return "time";
    case SYBBIGDATETIME:
      return "bigdatetime";
    case SYBBIGTIME:
      return "bigtime";
    case SYBCHAR:
      return "char";
    case SYBVARCHAR:
      return "varchar";
    case SYBTEXT:
      return "text";
    case SYBBINARY:
      return "binary";
    case SYBVARBINARY:
      return "varbinary";
    case SYBIMAGE:
      return "image";
    default:
      return "unknown";
  }
}

/** Whether a column type carries a date and/or time that we render ourselves. */
static int is_temporal_type(int coltype) {
  switch (coltype) {
    case SYBDATETIME:
    case SYBDATETIME4:
    case SYBDATE:
    case SYBTIME:
    case SYBBIGDATETIME:
    case SYBBIGTIME:
      return 1;
    default:
      return 0;
  }
}

/**
 * Render a date/time value as canonical, locale-independent text.
 *
 * `dbconvert(..., SYBCHAR, ...)` must NOT be used for these types. It formats
 * through `tds_ctx->locale->datetime_fmt`, which is
 *   1. read from `locales.conf` at the sysconfdir baked in at build time, using
 *      the section matching the process locale (the shipped file maps it_IT and
 *      pt_BR to "%d/%m/%Y %H:%M", es_ES to a format with no seconds), and
 *   2. finally handed to `strftime`, whose %b and %p are LC_TIME dependent.
 *
 * So the text a caller gets would depend on the machine's locale and on whether
 * a locales.conf happens to be reachable — the JS layer cannot reliably parse
 * that, and a mismatch would silently hand back raw text where a Date was
 * promised. Cracking the value into its parts and formatting it here removes
 * both variables: the output is byte-identical everywhere.
 *
 * Formats (matching the literals the driver writes, so reads and writes are
 * exact inverses):
 *   datetime, smalldatetime   YYYY-MM-DD HH:MM:SS.mmm
 *   bigdatetime               YYYY-MM-DD HH:MM:SS.mmmuuu
 *   date                      YYYY-MM-DD
 *   time                      HH:MM:SS.mmm
 *   bigtime                   HH:MM:SS.mmmuuu
 *
 * Returns the string length, or -1 if the value could not be cracked (the
 * caller then falls back to dbconvert rather than dropping the value).
 */
static int format_temporal_value(DBPROCESS *dbproc, int coltype, const void *src, char *buf,
                                 size_t buf_size) {
  // DBDATEREC2 carries nanoseconds, which is enough for bigdatetime's
  // microseconds. Sybase field naming (no MSDBLIB): month is 0-based.
  DBDATEREC2 di;
  memset(&di, 0, sizeof(di));

  if (dbanydatecrack(dbproc, &di, coltype, src) != SUCCEED) {
    return -1;
  }

  int year = (int)di.dateyear;
  int month = (int)di.datemonth + 1;
  int day = (int)di.datedmonth;
  int hour = (int)di.datehour;
  int minute = (int)di.dateminute;
  int second = (int)di.datesecond;
  long nanosecond = (long)di.datensecond;

  int written;
  switch (coltype) {
    case SYBDATE:
      written = snprintf(buf, buf_size, "%04d-%02d-%02d", year, month, day);
      break;
    case SYBTIME:
      written =
          snprintf(buf, buf_size, "%02d:%02d:%02d.%03ld", hour, minute, second, nanosecond / 1000000L);
      break;
    case SYBBIGTIME:
      written =
          snprintf(buf, buf_size, "%02d:%02d:%02d.%06ld", hour, minute, second, nanosecond / 1000L);
      break;
    case SYBBIGDATETIME:
      written = snprintf(buf, buf_size, "%04d-%02d-%02d %02d:%02d:%02d.%06ld", year, month, day, hour,
                         minute, second, nanosecond / 1000L);
      break;
    default:  // SYBDATETIME, SYBDATETIME4
      written = snprintf(buf, buf_size, "%04d-%02d-%02d %02d:%02d:%02d.%03ld", year, month, day, hour,
                         minute, second, nanosecond / 1000000L);
      break;
  }

  // snprintf returns the length it wanted; treat truncation as failure.
  if (written < 0 || (size_t)written >= buf_size) {
    return -1;
  }
  return written;
}

static void free_columns(ResultColumn *columns, int num_columns) {
  if (!columns) {
    return;
  }
  for (int i = 0; i < num_columns; i++) {
    free(columns[i].nulls);
    free(columns[i].fixed);
    free(columns[i].bytes);
    free(columns[i].ends);
    free(columns[i].units);
    free(columns[i].name);
  }
  free(columns);
}

// ---------------------------------------------------------------------------
// Async work: connect
// ---------------------------------------------------------------------------

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char host[256];
  int port;
  char database[256];
  char username[256];
  char password[256];
  int timeout_seconds;
  int packet_size;
  SybaseConnection *conn;
  char error[ERR_BUF_SIZE];
  int success;
} ConnectWork;

/**
 * Learn the server's default character set and set `conn->latin1` from it.
 *
 * Single-byte text (char, varchar, text) reaches the client as the server's own
 * bytes: ASE converts only to a character set it has installed, and FreeTDS only
 * when the server announces one, which ASE does not do here. So the bytes have
 * to be decoded knowing what they are. iso_1 bytes are Latin-1,
 * decoded one byte to one code point — losslessly, and the way other readers of
 * the same data (e.g. a Postgres replica loaded from it) decode them. A utf8
 * server's bytes are already UTF-8. Any other character set is passed through
 * as it always was; the JS layer warns about it (see `serverCharset`).
 *
 * Returns -1 (with `error` set) when the character set cannot be read: decoding
 * text without knowing it would silently garble every non-ASCII value.
 */
static int detect_server_charset(SybaseConnection *conn, char *error, size_t error_size) {
  conn->latin1 = 0;
  conn->charset[0] = '\0';
  clear_error(conn);
  int ok = dbcmd(conn->dbproc,
                 "select name from master..syscharsets where id = "
                 "(select value from master..sysconfigures where config = 131)") != FAIL &&
           dbsqlexec(conn->dbproc) != FAIL;
  RETCODE rc = SUCCEED;
  while (ok && (rc = dbresults(conn->dbproc)) != NO_MORE_RESULTS) {
    if (rc == FAIL) {
      ok = 0;
      break;
    }
    RETCODE row;
    while ((row = dbnextrow(conn->dbproc)) == REG_ROW) {
      int len = dbdatlen(conn->dbproc, 1);
      const char *name = (const char *)dbdata(conn->dbproc, 1);
      if (name && len > 0 && (size_t)len < sizeof(conn->charset)) {
        memcpy(conn->charset, name, (size_t)len);
        conn->charset[len] = '\0';
      }
    }
    if (row == FAIL) {
      ok = 0;
    }
  }
  if (!ok || conn->has_error || conn->charset[0] == '\0') {
    // Bounded: the server's message may fill the whole buffer on its own.
    snprintf(error, error_size, "Could not read the server's character set: %.3000s",
             conn->has_error ? conn->last_error : "no name in master..syscharsets");
    if (!DBDEAD(conn->dbproc)) {
      dbcancel(conn->dbproc);
    }
    return -1;
  }
  conn->latin1 = strcmp(conn->charset, "iso_1") == 0;
  clear_error(conn);
  return 0;
}

static void connect_execute(napi_env env, void *data) {
  (void)env;
  ConnectWork *w = (ConnectWork *)data;

  w->conn = (SybaseConnection *)calloc(1, sizeof(SybaseConnection));
  if (!w->conn) {
    snprintf(w->error, sizeof(w->error), "Memory allocation failed");
    w->success = 0;
    return;
  }
  if (uv_mutex_init(&w->conn->lock) != 0) {
    snprintf(w->error, sizeof(w->error), "Mutex init failed");
    free(w->conn);
    w->conn = NULL;
    w->success = 0;
    return;
  }
  w->conn->timeout_seconds = w->timeout_seconds;

  w->conn->login = dblogin();
  if (!w->conn->login) {
    snprintf(w->error, sizeof(w->error), "dblogin() failed");
    w->success = 0;
    uv_mutex_destroy(&w->conn->lock);
    free(w->conn);
    w->conn = NULL;
    return;
  }

  DBSETLUSER(w->conn->login, w->username);
  DBSETLPWD(w->conn->login, w->password);
  DBSETLAPP(w->conn->login, "drizzle-sybase");
  // unichar/univarchar arrive as UTF-16 and FreeTDS converts them to this. Set
  // explicitly, or FreeTDS takes it from the process locale — which is "C" in
  // Lambda, where a non-ASCII unichar value then comes back as '?'.
  DBSETLCHARSET(w->conn->login, "UTF-8");

  // Set TDS version to 5.0 (Sybase ASE native)
  DBSETLVERSION(w->conn->login, DBVERSION_100);

  // Negotiate a larger TDS packet so big result sets aren't shipped
  // 512 bytes at a time. The server may cap it, that's fine.
  if (w->packet_size > 0) {
    DBSETLPACKET(w->conn->login, w->packet_size);
  }

  // Build host:port string for dbopen.
  char server[300];
  snprintf(server, sizeof(server), "%s:%d", w->host, w->port);

  // dbsetlogintime() is process-global in FreeTDS. Serialize the
  // login-timeout-set + dbopen pair so concurrent connects with different
  // timeout values can't observe each other's setting.
  uv_mutex_lock(&login_mutex);
  if (w->timeout_seconds > 0) {
    dbsetlogintime(w->timeout_seconds);
  }
  login_error[0] = '\0';
  login_in_progress = 1;
  w->conn->dbproc = dbopen(w->conn->login, server);
  login_in_progress = 0;
  uv_mutex_unlock(&login_mutex);

  if (!w->conn->dbproc) {
    // Prefix, then as much of the server's messages as fits: they are what
    // says why (e.g. Msg 4002, Msg 911), and may be truncated, never overrun.
    int n = snprintf(w->error, sizeof(w->error), "Failed to connect to %s:%d", w->host, w->port);
    if (login_error[0] != '\0' && n > 0 && (size_t)n < sizeof(w->error)) {
      snprintf(w->error + n, sizeof(w->error) - (size_t)n, ": %s", login_error);
    }
    dbloginfree(w->conn->login);
    uv_mutex_destroy(&w->conn->lock);
    free(w->conn);
    w->conn = NULL;
    w->success = 0;
    return;
  }

  // Associate our connection struct with the DBPROCESS so the global
  // err/msg handlers can find it.
  dbsetuserdata(w->conn->dbproc, (BYTE *)w->conn);

  // Per-connection query timeout. Replaces the legacy process-global
  // dbsettime(). dbsetopt takes the value as a decimal string.
  if (w->timeout_seconds > 0) {
    char tval[16];
    snprintf(tval, sizeof(tval), "%d", w->timeout_seconds);
    dbsetopt(w->conn->dbproc, DBSETTIME, tval, 0);
  }

  // Switch database
  if (strlen(w->database) > 0) {
    clear_error(w->conn);
    if (dbuse(w->conn->dbproc, w->database) == FAIL) {
      if (w->conn->has_error) {
        snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
      } else {
        snprintf(w->error, sizeof(w->error),
                 "Failed to use database '%s'", w->database);
      }
      dbclose(w->conn->dbproc);
      dbloginfree(w->conn->login);
      uv_mutex_destroy(&w->conn->lock);
      free(w->conn);
      w->conn = NULL;
      w->success = 0;
      return;
    }
  }

  if (detect_server_charset(w->conn, w->error, sizeof(w->error)) != 0) {
    dbclose(w->conn->dbproc);
    dbloginfree(w->conn->login);
    uv_mutex_destroy(&w->conn->lock);
    free(w->conn);
    w->conn = NULL;
    w->success = 0;
    return;
  }
  w->success = 1;
}

static void connect_complete(napi_env env, napi_status status, void *data) {
  ConnectWork *w = (ConnectWork *)data;

  if (status == napi_cancelled || !w->success) {
    // Cancelled after a successful connect: nothing will ever own it.
    if (w->success && w->conn) {
      close_connection(w->conn);
    }
    napi_value error_msg, error_obj;
    napi_create_string_utf8(env, w->error, NAPI_AUTO_LENGTH, &error_msg);
    napi_create_error(env, NULL, error_msg, &error_obj);
    napi_reject_deferred(env, w->deferred, error_obj);
  } else {
    napi_value result;
    ConnHandle *handle = (ConnHandle *)malloc(sizeof(ConnHandle));
    if (handle == NULL ||
        napi_create_external(env, handle, conn_handle_finalize, NULL, &result) != napi_ok) {
      // No handle for JS to close it through: close it here.
      free(handle);
      close_connection(w->conn);
      napi_value error_msg, error_obj;
      napi_create_string_utf8(env, "Could not create a connection handle", NAPI_AUTO_LENGTH,
                              &error_msg);
      napi_create_error(env, NULL, error_msg, &error_obj);
      napi_reject_deferred(env, w->deferred, error_obj);
    } else {
      handle->conn = w->conn;
      napi_type_tag_object(env, result, &CONN_HANDLE_TAG);
      napi_resolve_deferred(env, w->deferred, result);
    }
  }

  napi_delete_async_work(env, w->work);
  free(w);
}

// napi_value connect(config: { host, port, database, username, password, timeout?, packetSize? })
static napi_value fn_connect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  ConnectWork *w = (ConnectWork *)calloc(1, sizeof(ConnectWork));

  napi_value val;
  size_t len;
  napi_valuetype vtype;

  napi_get_named_property(env, args[0], "host", &val);
  napi_get_value_string_utf8(env, val, w->host, sizeof(w->host), &len);

  napi_get_named_property(env, args[0], "port", &val);
  napi_get_value_int32(env, val, &w->port);

  napi_get_named_property(env, args[0], "database", &val);
  napi_get_value_string_utf8(env, val, w->database, sizeof(w->database), &len);

  napi_get_named_property(env, args[0], "username", &val);
  napi_get_value_string_utf8(env, val, w->username, sizeof(w->username), &len);

  napi_get_named_property(env, args[0], "password", &val);
  napi_get_value_string_utf8(env, val, w->password, sizeof(w->password), &len);

  // Optional timeout (seconds), default 30s. Values <= 0 are coerced to 1
  // because dbsetlogintime() ignores zero/negative input but its prior
  // process-global value would silently leak through.
  w->timeout_seconds = 30;
  napi_get_named_property(env, args[0], "timeout", &val);
  napi_typeof(env, val, &vtype);
  if (vtype == napi_number) {
    napi_get_value_int32(env, val, &w->timeout_seconds);
  }
  if (w->timeout_seconds <= 0) {
    w->timeout_seconds = 1;
  }

  // Optional TDS packet size override.
  w->packet_size = DEFAULT_PACKET_SIZE;
  napi_get_named_property(env, args[0], "packetSize", &val);
  napi_typeof(env, val, &vtype);
  if (vtype == napi_number) {
    napi_get_value_int32(env, val, &w->packet_size);
  }

  napi_value promise;
  napi_create_promise(env, &w->deferred, &promise);

  napi_value work_name;
  napi_create_string_utf8(env, "sybase_connect", NAPI_AUTO_LENGTH, &work_name);
  napi_create_async_work(env, NULL, work_name, connect_execute, connect_complete, w, &w->work);
  napi_queue_async_work(env, w->work);

  return promise;
}

// ---------------------------------------------------------------------------
// Async work: query (with hard-timeout watchdog)
// ---------------------------------------------------------------------------

/**
 * Watchdog state.
 *
 * Lifecycle:
 *   1. fn_query allocates the QueryWork and a Watchdog inside it.
 *   2. query_execute starts a uv_thread that waits up to deadline_ms.
 *      The wait is interruptible via uv_cond_signal on `cond`.
 *   3. When the worker finishes (success or error) it signals the watchdog
 *      so the thread exits cleanly without firing.
 *   4. If the watchdog fires (worker still blocked past hardTimeoutMs):
 *        - marks the connection dead (so the pool replaces it)
 *        - sets `fired = 1` so query_execute can rewrite the error to a
 *          clear hard-timeout message before the promise resolves.
 *
 *   We deliberately do NOT call dbcancel from this thread — dbcancel calls
 *   tds_process_cancel which reads from the same socket the worker reads
 *   from. We rely on db-lib's per-connection DBSETTIME to unblock the
 *   worker; in the meantime the JS-side Promise.race in
 *   SybaseConnection.executeQuery() guarantees the user's promise rejects
 *   on schedule even if the libuv worker is still parked.
 */
typedef struct Watchdog {
  uv_thread_t thread;
  uv_mutex_t mutex;
  uv_cond_t cond;
  int started;     // 1 once the thread has been spawned
  int finished;    // set by worker before signaling cond
  int fired;       // set by watchdog when deadline elapsed
  int deadline_ms;
  SybaseConnection *conn;
} Watchdog;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  SybaseConnection *conn;
  char *sql;
  int max_rows;
  // 1 when the caller asked for maxRows: hitting it is then the requested
  // truncation. Hitting the internal safety cap instead fails the query.
  int max_rows_explicit;
  int truncated;
  int hard_timeout_ms;
  // 1 to hand datetime/smalldatetime over as wall-clock numbers (KIND_WALLCLOCK)
  // for the JS layer to turn into Dates, instead of as canonical text.
  int wall_clock_datetimes;
  // Set to stream the result to a CSV file instead of collecting it (see
  // csv_write_row); the rows are then never held, so no default row cap applies.
  char *out_path;
  // Written first, renamed to out_path only once the whole result is in it.
  char *out_tmp;
  FILE *out;
  char *out_buf;
  size_t out_len;
  int64_t out_rows;
  int64_t out_bytes;
  // Results
  ResultColumn *columns;
  int num_columns;
  int num_rows;
  int affected_rows;
  char error[ERR_BUF_SIZE];
  int success;
  // Snapshot of connection state captured before conn_release, so
  // query_complete (JS thread) can build the error object without ever
  // dereferencing w->conn — which may have been freed by then.
  int conn_dead;
  int conn_timed_out;
  // 1 while this work item holds an in-flight slot on `conn`. Taken in
  // fn_query on the JS thread *before* the work is queued, so a close issued
  // while the work waits in the libuv queue defers the free instead of
  // leaving the worker with a dangling pointer.
  int holds_conn;
  // Watchdog
  Watchdog wd;
} QueryWork;

static void watchdog_thread(void *arg) {
  Watchdog *wd = (Watchdog *)arg;

  uv_mutex_lock(&wd->mutex);
  if (!wd->finished) {
    uint64_t timeout_ns = (uint64_t)wd->deadline_ms * 1000000ULL;
    int rc = uv_cond_timedwait(&wd->cond, &wd->mutex, timeout_ns);
    if (rc == UV_ETIMEDOUT && !wd->finished) {
      wd->fired = 1;
      if (wd->conn) {
        conn_mark_dead(wd->conn);
      }
    }
  }
  uv_mutex_unlock(&wd->mutex);
}

static int watchdog_start(Watchdog *wd, SybaseConnection *conn, int deadline_ms) {
  if (deadline_ms <= 0) {
    return 0; // disabled
  }
  if (uv_mutex_init(&wd->mutex) != 0) {
    return -1;
  }
  if (uv_cond_init(&wd->cond) != 0) {
    uv_mutex_destroy(&wd->mutex);
    return -1;
  }
  wd->finished = 0;
  wd->fired = 0;
  wd->started = 0;
  wd->conn = conn;
  wd->deadline_ms = deadline_ms;
  if (uv_thread_create(&wd->thread, watchdog_thread, wd) != 0) {
    uv_cond_destroy(&wd->cond);
    uv_mutex_destroy(&wd->mutex);
    return -1;
  }
  wd->started = 1;
  return 0;
}

static void watchdog_stop(Watchdog *wd) {
  if (!wd->started) {
    return;
  }
  uv_mutex_lock(&wd->mutex);
  wd->finished = 1;
  uv_cond_signal(&wd->cond);
  uv_mutex_unlock(&wd->mutex);
  uv_thread_join(&wd->thread);
  uv_cond_destroy(&wd->cond);
  uv_mutex_destroy(&wd->mutex);
  wd->started = 0;
}

/**
 * Drop this work item's in-flight slot. May free the connection if a close is
 * pending; w->conn must not be dereferenced afterwards.
 */
static void work_release_conn(QueryWork *w) {
  if (w->holds_conn) {
    w->holds_conn = 0;
    conn_release(w->conn);
  }
}

/** Drop whatever result the work item has collected. */
static void discard_results(QueryWork *w) {
  free_columns(w->columns, w->num_columns);
  w->columns = NULL;
  w->num_columns = 0;
  w->num_rows = 0;
}

/** How a column of this type is stored (see ValueKind). */
static ValueKind column_kind(int coltype, int wall_clock_datetimes) {
  if (is_binary_type(coltype)) {
    return KIND_BINARY;
  }
  if (coltype == TDS_USMALLINT || coltype == TDS_UINT) {
    // Up to 4294967295: past int32, but exact in a double.
    return KIND_FLOAT64;
  }
  if (coltype == TDS_UBIGINT) {
    // Up to 18446744073709551615 — past even int64, so a uint64 BigInt.
    return KIND_UINT64;
  }
  switch (coltype) {
    case SYBINT1:
    case SYBINT2:
    case SYBINT4:
      return KIND_INT32;
    case SYBINT8:
      // bigint is 64-bit: up to 9223372036854775807, which a double cannot
      // hold. A double silently rounds anything past 2^53 (9007199254740993
      // reads back as 9007199254740992), so the value is handed over as a
      // BigInt — the only exact JS integer type. Mixing a BigInt into number
      // arithmetic throws rather than corrupting the result, which is the
      // behaviour we want here.
      return KIND_INT64;
    case SYBFLT8:
    case SYBREAL:
      return KIND_FLOAT64;
    case SYBBIT:
      return KIND_BOOL;
    case SYBDATETIME:
    case SYBDATETIME4:
      return wall_clock_datetimes ? KIND_WALLCLOCK : KIND_TEXT;
    default:
      // Money and decimal stay text to preserve precision (a JS number loses
      // it beyond ~15 digits), as do every other type JS has no exact form for.
      return KIND_TEXT;
  }
}

/** Days from 1970-01-01 to a proleptic Gregorian date (month 1-12). */
static int64_t days_from_civil(int64_t year, int month, int day) {
  year -= month <= 2;
  int64_t era = (year >= 0 ? year : year - 399) / 400;
  int64_t year_of_era = year - era * 400;
  int64_t day_of_year = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1;
  int64_t day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  return era * 146097 + day_of_era - 719468;
}

/**
 * A datetime/smalldatetime as its wall clock in milliseconds since 1970-01-01,
 * read as if it were UTC — the exact value format_temporal_value renders as
 * text, so both forms decode to the same Date. Returns -1 if it cannot be cracked.
 */
static int wall_clock_ms(DBPROCESS *dbproc, int coltype, const BYTE *src, double *out) {
  DBDATEREC2 di;
  memset(&di, 0, sizeof(di));
  if (dbanydatecrack(dbproc, &di, coltype, src) != SUCCEED) {
    return -1;
  }
  // Sybase field naming (no MSDBLIB): month is 0-based.
  int64_t days = days_from_civil((int64_t)di.dateyear, (int)di.datemonth + 1, (int)di.datedmonth);
  int64_t seconds = (int64_t)di.datehour * 3600 + (int64_t)di.dateminute * 60 + (int64_t)di.datesecond;
  int64_t ms = days * 86400000LL + seconds * 1000LL + (int64_t)di.datensecond / 1000000LL;
  *out = (double)ms;
  return 0;
}

/** Write `n` in decimal; returns the number of digits. */
static int write_decimal(char *out, uint64_t n) {
  char digits[20];
  int count = 0;
  do {
    digits[count++] = (char)('0' + n % 10);
    n /= 10;
  } while (n);
  for (int i = 0; i < count; i++) {
    out[i] = digits[count - 1 - i];
  }
  return count;
}

/** An amount in ten-thousandths as `[-]whole.ffff`, the way db-lib renders money. */
static int write_money(char *out, int negative, uint64_t units) {
  int len = 0;
  if (negative) {
    out[len++] = '-';
  }
  len += write_decimal(out + len, units / 10000);
  unsigned fraction = (unsigned)(units % 10000);
  out[len++] = '.';
  out[len++] = (char)('0' + fraction / 1000);
  out[len++] = (char)('0' + fraction / 100 % 10);
  out[len++] = (char)('0' + fraction / 10 % 10);
  out[len++] = (char)('0' + fraction % 10);
  return len;
}

/**
 * Bytes a numeric of each precision (1-77) occupies on the wire: a sign byte,
 * then the magnitude, big-endian, in the fewest bytes that hold 10^p - 1.
 */
static const unsigned char NUMERIC_BYTES[78] = {
    1,  2,  2,  3,  3,  4,  4,  4,  5,  5,  6,  6,  6,  7,  7,  8,  8,  9,  9,  9,
    10, 10, 11, 11, 11, 12, 12, 13, 13, 14, 14, 14, 15, 15, 16, 16, 16, 17, 17, 18,
    18, 19, 19, 19, 20, 20, 21, 21, 21, 22, 22, 23, 23, 24, 24, 24, 25, 25, 26, 26,
    26, 27, 27, 28, 28, 28, 29, 29, 30, 30, 31, 31, 31, 32, 32, 33, 33, 33};

/**
 * A numeric/decimal as db-lib renders it: `[-]digits[.fraction]`, exactly
 * `scale` fraction digits, and a `0` before the point when there is no integer
 * part. Returns -1 for a value it cannot read (left to dbconvert).
 */
static int write_numeric(char *out, const DBNUMERIC *num) {
  int precision = num->precision;
  int scale = num->scale;
  if (precision < 1 || precision > 77 || scale > precision) {
    return -1;
  }

  // The magnitude as 32-bit limbs, most significant first.
  int magnitude_bytes = NUMERIC_BYTES[precision] - 1;
  int limb_count = (magnitude_bytes + 3) / 4;
  uint32_t limbs[8] = {0};
  for (int b = 0; b < magnitude_bytes; b++) {
    int from_low = magnitude_bytes - 1 - b;
    limbs[limb_count - 1 - from_low / 4] |= (uint32_t)num->array[1 + b] << (8 * (from_low % 4));
  }

  // Decimal digits, least significant first, nine at a time.
  char digits[81];
  int count = 0;
  int first = 0;
  while (first < limb_count && limbs[first] == 0) {
    first++;
  }
  while (first < limb_count) {
    uint64_t remainder = 0;
    for (int i = first; i < limb_count; i++) {
      uint64_t current = (remainder << 32) | limbs[i];
      limbs[i] = (uint32_t)(current / 1000000000u);
      remainder = current % 1000000000u;
    }
    while (first < limb_count && limbs[first] == 0) {
      first++;
    }
    for (int k = 0; k < 9; k++) {
      digits[count++] = (char)('0' + remainder % 10);
      remainder /= 10;
    }
  }
  while (count > 0 && digits[count - 1] == '0') {
    count--;
  }

  int len = 0;
  if (num->array[0] == 1) {
    out[len++] = '-';
  }
  if (count <= scale) {
    out[len++] = '0';
    if (scale > 0) {
      out[len++] = '.';
      for (int i = count; i < scale; i++) {
        out[len++] = '0';
      }
    }
    for (int i = count - 1; i >= 0; i--) {
      out[len++] = digits[i];
    }
    return len;
  }
  for (int i = count - 1; i >= 0; i--) {
    out[len++] = digits[i];
    if (i == scale && scale > 0) {
      out[len++] = '.';
    }
  }
  return len;
}

/**
 * Money and decimal as text, formatted here: dbconvert allocates a copy of
 * every value and blank-pads its output, which made these the costliest
 * columns to read. The output matches dbconvert's byte for byte. `out` needs
 * 128 bytes. Returns -1 if the value is not in the expected form, for the
 * caller to fall back to dbconvert.
 */
static int format_exact_numeric(int coltype, const BYTE *src, int datalen, char *out) {
  switch (coltype) {
    case SYBMONEY: {
      DBMONEY money;
      if (datalen != (int)sizeof(money)) {
        return -1;
      }
      memcpy(&money, src, sizeof(money));
      uint64_t bits = ((uint64_t)(uint32_t)money.mnyhigh << 32) | money.mnylow;
      int negative = money.mnyhigh < 0;
      return write_money(out, negative, negative ? (uint64_t)0 - bits : bits);
    }
    case SYBMONEY4: {
      DBMONEY4 money;
      if (datalen != (int)sizeof(money)) {
        return -1;
      }
      memcpy(&money, src, sizeof(money));
      uint32_t bits = (uint32_t)money.mny4;
      int negative = money.mny4 < 0;
      return write_money(out, negative, negative ? (uint32_t)0 - bits : bits);
    }
    case SYBNUMERIC:
    case SYBDECIMAL: {
      DBNUMERIC num;
      if (datalen != (int)sizeof(num)) {
        return -1;
      }
      memcpy(&num, src, sizeof(num));
      return write_numeric(out, &num);
    }
    default:
      return -1;
  }
}

/** Make room for `extra` more bytes in a text/binary column. */
static int reserve_bytes(ResultColumn *col, size_t extra) {
  if (col->bytes_cap - col->bytes_len >= extra) {
    return 0;
  }
  if (extra > SIZE_MAX - col->bytes_len) {
    return -1;
  }
  size_t cap = col->bytes_cap > 0 ? col->bytes_cap : 4096;
  while (cap - col->bytes_len < extra) {
    if (cap > SIZE_MAX / 2) {
      cap = col->bytes_len + extra;
      break;
    }
    cap *= 2;
  }
  char *grown = (char *)realloc(col->bytes, cap);
  if (!grown) {
    return -1;
  }
  col->bytes = grown;
  col->bytes_cap = cap;
  return 0;
}

/** Size the per-row arrays of every column for `capacity` rows. */
static int grow_rows(ResultColumn *columns, int num_columns, int capacity) {
  for (int i = 0; i < num_columns; i++) {
    ResultColumn *col = &columns[i];
    unsigned char *nulls = (unsigned char *)realloc(col->nulls, (size_t)capacity);
    if (!nulls) {
      return -1;
    }
    col->nulls = nulls;
    size_t size = kind_size(col->kind);
    if (size > 0) {
      unsigned char *fixed = (unsigned char *)realloc(col->fixed, (size_t)capacity * size);
      if (!fixed) {
        return -1;
      }
      col->fixed = fixed;
    } else {
      size_t *ends = (size_t *)realloc(col->ends, (size_t)capacity * sizeof(size_t));
      if (!ends) {
        return -1;
      }
      col->ends = ends;
      if (col->kind == KIND_TEXT) {
        uint32_t *units = (uint32_t *)realloc(col->units, (size_t)capacity * sizeof(uint32_t));
        if (!units) {
          return -1;
        }
        col->units = units;
      }
    }
  }
  return 0;
}

/**
 * Decode a fixed-width value from db-lib's binary form into `out`. The
 * byte-length checks guard against a type whose wire size is not the one
 * assumed here: reading it anyway would hand JS a wrong number.
 * Returns -1 (with `w->error` set) on failure.
 */
static int store_fixed(QueryWork *w, ResultColumn *col, int coltype, const BYTE *src, int datalen,
                       unsigned char *out) {
  int ok = 1;
  switch (col->kind) {
    case KIND_INT32: {
      int32_t v = 0;
      if (coltype == SYBINT1 && datalen == 1) {
        v = (int32_t)(*(const DBTINYINT *)src);  // tinyint is unsigned
      } else if (coltype == SYBINT2 && datalen == 2) {
        DBSMALLINT s;
        memcpy(&s, src, sizeof(s));
        v = s;
      } else if (coltype == SYBINT4 && datalen == 4) {
        memcpy(&v, src, sizeof(v));
      } else {
        ok = 0;
      }
      memcpy(out, &v, sizeof(v));
      break;
    }
    case KIND_FLOAT64: {
      double v = 0;
      if (coltype == SYBFLT8 && datalen == 8) {
        memcpy(&v, src, sizeof(v));
      } else if (coltype == SYBREAL && datalen == 4) {
        // Through the shortest text that round-trips the float, as db-lib's
        // own conversion renders it ("%.9g"): 3.14 reads as 3.1400001, not
        // the 3.140000104904175 a plain widening gives.
        DBREAL f;
        char text[32];
        memcpy(&f, src, sizeof(f));
        snprintf(text, sizeof(text), "%.9g", (double)f);
        v = strtod(text, NULL);
      } else if (coltype == TDS_USMALLINT && datalen == 2) {
        uint16_t u;
        memcpy(&u, src, sizeof(u));
        v = (double)u;
      } else if (coltype == TDS_UINT && datalen == 4) {
        uint32_t u;
        memcpy(&u, src, sizeof(u));
        v = (double)u;
      } else {
        ok = 0;
      }
      memcpy(out, &v, sizeof(v));
      break;
    }
    case KIND_INT64:
    case KIND_UINT64:
      if (datalen == 8) {
        memcpy(out, src, 8);
      } else {
        ok = 0;
      }
      break;
    case KIND_BOOL:
      if (datalen == 1) {
        *out = *src != 0;
      } else {
        ok = 0;
      }
      break;
    case KIND_WALLCLOCK: {
      double v = 0;
      if (datalen <= 0 || wall_clock_ms(w->conn->dbproc, coltype, src, &v) != 0) {
        snprintf(w->error, sizeof(w->error),
                 "Could not decode %s column '%s' (%d bytes) into a wall clock",
                 syb_type_name(coltype), col->name, datalen);
        return -1;
      }
      memcpy(out, &v, sizeof(v));
      break;
    }
    default:
      ok = 0;
      break;
  }
  if (!ok) {
    snprintf(w->error, sizeof(w->error), "Unexpected %d-byte value in %s column '%s'", datalen,
             syb_type_name(coltype), col->name);
    return -1;
  }
  return 0;
}

/**
 * Copy text as valid UTF-8, replacing each maximal invalid subsequence with
 * U+FFFD — the WHATWG decoder's rule, which is what V8 applies when the same
 * bytes become a JS string, so a file and a row result hold the same value.
 * `out` needs room for 3 bytes per input byte. Returns the length written.
 */
static size_t utf8_sanitize(const unsigned char *in, size_t n, unsigned char *out) {
  size_t len = 0, seq_start = 0;
  int needed = 0, seen = 0;
  unsigned char lower = 0x80, upper = 0xBF;
  for (size_t i = 0; i < n; i++) {
    unsigned char b = in[i];
    if (needed > 0) {
      if (b >= lower && b <= upper) {
        lower = 0x80, upper = 0xBF;
        if (++seen == needed) {
          memcpy(out + len, in + seq_start, (size_t)needed + 1);
          len += (size_t)needed + 1;
          needed = 0, seen = 0;
        }
        continue;
      }
      // The sequence so far is one invalid subpart; this byte starts afresh.
      out[len++] = 0xEF, out[len++] = 0xBF, out[len++] = 0xBD;
      needed = 0, seen = 0, lower = 0x80, upper = 0xBF;
    }
    seq_start = i;
    if (b <= 0x7F) {
      out[len++] = b;
    } else if (b >= 0xC2 && b <= 0xDF) {
      needed = 1;
    } else if (b >= 0xE0 && b <= 0xEF) {
      lower = b == 0xE0 ? 0xA0 : 0x80;
      upper = b == 0xED ? 0x9F : 0xBF;
      needed = 2;
    } else if (b >= 0xF0 && b <= 0xF4) {
      lower = b == 0xF0 ? 0x90 : 0x80;
      upper = b == 0xF4 ? 0x8F : 0xBF;
      needed = 3;
    } else {
      out[len++] = 0xEF, out[len++] = 0xBF, out[len++] = 0xBD;
    }
  }
  if (needed > 0) {
    out[len++] = 0xEF, out[len++] = 0xBF, out[len++] = 0xBD;
  }
  return len;
}

static int is_ascii(const char *text, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if ((unsigned char)text[i] >= 0x80) {
      return 0;
    }
  }
  return 1;
}

/** Length in UTF-16 code units of valid UTF-8: one per code point, two past U+FFFF. */
static uint32_t utf16_length(const unsigned char *utf8, size_t n) {
  uint32_t units = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char b = utf8[i];
    units += (b & 0xC0) != 0x80;  // a code point starts here
    units += b >= 0xF0;           // ... and needs a surrogate pair
  }
  return units;
}

/**
 * Append a value as text, followed by the NUL that separates it from the next.
 * Returns -1 (with `w->error` set) on failure.
 */
static int store_text(QueryWork *w, ResultColumn *col, int r, int coltype, const BYTE *src,
                      int datalen) {
  char *dest;
  int len;

  if (coltype == SYBCHAR || coltype == SYBVARCHAR || coltype == SYBTEXT) {
    // Already text: dbconvert would only copy it (after blank-padding the
    // whole destination buffer). Latin-1 grows to at most 2 bytes per byte,
    // and the result must still fit an int length.
    if (col->latin1 && datalen > (INT_MAX - 1) / 2) {
      snprintf(w->error, sizeof(w->error), "%s value in column '%s' is too large (%d bytes)",
               syb_type_name(coltype), col->name, datalen);
      return -1;
    }
    if (reserve_bytes(col, (size_t)datalen * (col->latin1 ? 2 : 1) + 1) != 0) {
      goto oom;
    }
    dest = col->bytes + col->bytes_len;
    if (col->latin1) {
      len = (int)latin1_to_utf8(src, (size_t)datalen, (unsigned char *)dest);
    } else {
      memcpy(dest, src, (size_t)datalen);
      len = datalen;
    }
  } else if (is_temporal_type(coltype)) {
    // Date/time values are formatted here, never by dbconvert, which renders
    // them through a locale-dependent format string that in several locales
    // drops the seconds and milliseconds outright — see format_temporal_value.
    // There is deliberately no fallback: falling back would reintroduce exactly
    // the lossy, machine-dependent text this exists to remove, and the JS layer
    // would then be handed a string it cannot parse. Failing the query says so
    // directly.
    const size_t size = 64;
    if (reserve_bytes(col, size + 1) != 0) {
      goto oom;
    }
    dest = col->bytes + col->bytes_len;
    len = datalen > 0 ? format_temporal_value(w->conn->dbproc, coltype, src, dest, size) : -1;
    if (len < 0) {
      snprintf(w->error, sizeof(w->error),
               "Could not decode %s column '%s' (%d bytes) into canonical text",
               syb_type_name(coltype), col->name, datalen);
      return -1;
    }
  } else {
    // dbconvert blank-pads its output to the whole destination size, so that
    // is kept to what the type can need. Money and decimal render in at most
    // 41 characters (38 digits, sign, point and a leading zero); anything else
    // gets room for the usual expansion, with an 8 KB floor for small values.
    int is_exact_numeric = coltype == SYBMONEY || coltype == SYBMONEY4 ||
                           coltype == SYBNUMERIC || coltype == SYBDECIMAL;
    // dbconvert takes the destination size as an int.
    if (datalen > (INT_MAX - 64) / 2) {
      snprintf(w->error, sizeof(w->error), "%s value in column '%s' is too large (%d bytes)",
               syb_type_name(coltype), col->name, datalen);
      return -1;
    }
    int buf_size = is_exact_numeric ? 128 : datalen > 4096 ? datalen * 2 + 64 : 8192;
    if (reserve_bytes(col, (size_t)buf_size) != 0) {
      goto oom;
    }
    dest = col->bytes + col->bytes_len;
    len = is_exact_numeric ? format_exact_numeric(coltype, src, datalen, dest) : -1;
    if (len < 0) {
      // A zero-length value is empty text. dbconvert would instead render it
      // as db-lib's NULL substitute: `buf_size - 1` blanks.
      len = datalen > 0 ? dbconvert(w->conn->dbproc, coltype, src, datalen, SYBCHAR, (BYTE *)dest,
                                    buf_size - 1)
                        : 0;
    }
    if (len < 0) {
      len = 0;
    }
  }

  // Trim trailing spaces for CHAR/NCHAR fixed-width types
  if (coltype == SYBCHAR) {
    while (len > 0 && dest[len - 1] == ' ') {
      len--;
    }
  }
  // Make it valid UTF-8, the way V8 would when the bytes become a JS string,
  // so that every path — rows, columns, a CSV file — holds the same value and
  // its UTF-16 length is known here. Latin-1 decoding is valid already.
  size_t n = (size_t)len;
  if (!col->latin1 && !is_ascii(dest, n)) {
    char *raw = (char *)malloc(n);
    if (!raw) {
      goto oom;
    }
    memcpy(raw, dest, n);
    if (reserve_bytes(col, n * 3) != 0) {
      free(raw);
      goto oom;
    }
    dest = col->bytes + col->bytes_len;
    n = utf8_sanitize((const unsigned char *)raw, n, (unsigned char *)dest);
    free(raw);
  }
  // NULs are kept: a value is cut out by length, never at a terminator.
  col->units[r] = utf16_length((const unsigned char *)dest, n);
  col->bytes_len += n;
  col->ends[r] = col->bytes_len;
  return 0;

oom:
  snprintf(w->error, sizeof(w->error), "Memory allocation failed for column value");
  return -1;
}

/**
 * Store column `i` of the current row in slot `r`. Returns -1 (with
 * `w->error` set) on failure.
 */
static int store_cell(QueryWork *w, int i, int r) {
  ResultColumn *col = &w->columns[i];
  int colno = i + 1;
  BYTE *src = dbdata(w->conn->dbproc, colno);
  int datalen = dbdatlen(w->conn->dbproc, colno);
  size_t size = kind_size(col->kind);

  if (datalen == 0 && src == NULL) {
    col->nulls[r] = 1;
    col->has_nulls = 1;
    if (size > 0) {
      memset(col->fixed + (size_t)r * size, 0, size);
    } else {
      col->ends[r] = col->bytes_len;
      if (col->kind == KIND_TEXT) {
        col->units[r] = 0;
      }
    }
    return 0;
  }
  col->nulls[r] = 0;

  if (size > 0) {
    // The resolved type, not dbcoltype(): a nullable unsigned column reports
    // TDS_UINTN there, and only its size says which type it is.
    return store_fixed(w, col, col->type, src, datalen, col->fixed + (size_t)r * size);
  }
  if (col->kind == KIND_BINARY) {
    // Binary: keep the raw bytes. Converting to SYBCHAR would hand JS a hex
    // string, which is neither what the schema declares nor what a write of
    // the same value produces.
    if (reserve_bytes(col, (size_t)datalen) != 0) {
      snprintf(w->error, sizeof(w->error), "Memory allocation failed for column value");
      return -1;
    }
    if (datalen > 0) {
      memcpy(col->bytes + col->bytes_len, src, (size_t)datalen);
    }
    col->bytes_len += (size_t)datalen;
    col->ends[r] = col->bytes_len;
    return 0;
  }
  return store_text(w, col, r, dbcoltype(w->conn->dbproc, colno), src, datalen);
}

// ---------------------------------------------------------------------------
// Streaming a result to a CSV file
//
// RFC 4180: comma-separated, a header row of column names, fields quoted when
// they hold a comma, quote, line break or NUL (or are empty, or start or end with a
// blank), quotes doubled. NULL is an empty unquoted field, so it stays distinct
// from an empty string (""). Values are the ones a row result holds, rendered
// as text: the same conversion code produces them. Binary is lowercase hex.
// ---------------------------------------------------------------------------

#define OUT_BUF_SIZE ((size_t)1 << 20)

#if defined(_WIN32)
/** A UTF-8 path as the UTF-16 Windows wants; NULL if it cannot be converted. */
static wchar_t *wide_path(const char *path) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  wchar_t *wide = n > 0 ? (wchar_t *)malloc((size_t)n * sizeof(wchar_t)) : NULL;
  if (wide) {
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, n);
  }
  return wide;
}
#endif

/**
 * Create (exclusively: never an existing file) `path` for writing. On POSIX it
 * is readable by its owner only, since it holds query results, and it is not
 * inherited by child processes. On Windows it takes its directory's ACL.
 */
static FILE *open_output(const char *path) {
#if defined(_WIN32)
  wchar_t *wide = wide_path(path);
  FILE *f = wide ? _wfopen(wide, L"wbx") : NULL;
  free(wide);
  return f;
#else
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0) {
    return NULL;
  }
  FILE *f = fdopen(fd, "wb");
  if (!f) {
    int saved = errno;
    close(fd);
    errno = saved;
  }
  return f;
#endif
}

static void remove_output(const char *path) {
#if defined(_WIN32)
  wchar_t *wide = wide_path(path);
  if (wide) {
    _wremove(wide);
    free(wide);
  }
#else
  remove(path);
#endif
}

/** Replace `to` with `from` in one step: a reader sees the old file or the new one. */
static int publish_output(const char *from, const char *to) {
#if defined(_WIN32)
  wchar_t *wfrom = wide_path(from), *wto = wide_path(to);
  int ok = wfrom && wto && MoveFileExW(wfrom, wto, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  free(wfrom);
  free(wto);
  return ok ? 0 : -1;
#else
  return rename(from, to);
#endif
}

static int out_flush(QueryWork *w) {
  if (w->out_len > 0) {
    if (fwrite(w->out_buf, 1, w->out_len, w->out) != w->out_len) {
      snprintf(w->error, sizeof(w->error), "Could not write to %s: %s", w->out_path, strerror(errno));
      return -1;
    }
    w->out_bytes += (int64_t)w->out_len;
    w->out_len = 0;
  }
  return 0;
}

static int out_write(QueryWork *w, const char *data, size_t n) {
  if (OUT_BUF_SIZE - w->out_len < n) {
    if (out_flush(w) != 0) {
      return -1;
    }
    if (n > OUT_BUF_SIZE) {
      if (fwrite(data, 1, n, w->out) != n) {
        snprintf(w->error, sizeof(w->error), "Could not write to %s: %s", w->out_path,
                 strerror(errno));
        return -1;
      }
      w->out_bytes += (int64_t)n;
      return 0;
    }
  }
  memcpy(w->out_buf + w->out_len, data, n);
  w->out_len += n;
  return 0;
}

static int out_char(QueryWork *w, char c) {
  if (w->out_len == OUT_BUF_SIZE && out_flush(w) != 0) {
    return -1;
  }
  w->out_buf[w->out_len++] = c;
  return 0;
}

/** A text field (valid UTF-8, see store_text), quoted only when it has to be. */
static int out_text_field(QueryWork *w, const char *text, size_t n) {
  int quote = n == 0 || text[0] == ' ' || text[0] == '\t' || text[n - 1] == ' ' ||
              text[n - 1] == '\t';
  for (size_t i = 0; !quote && i < n; i++) {
    char c = text[i];
    quote = c == ',' || c == '"' || c == '\n' || c == '\r' || c == '\0';
  }
  if (!quote) {
    return out_write(w, text, n);
  }
  if (out_char(w, '"') != 0) {
    return -1;
  }
  size_t start = 0;
  for (size_t i = 0; i < n; i++) {
    if (text[i] == '"') {
      // Through the quote, then the quote again.
      if (out_write(w, text + start, i + 1 - start) != 0 || out_char(w, '"') != 0) {
        return -1;
      }
      start = i + 1;
    }
  }
  if (out_write(w, text + start, n - start) != 0) {
    return -1;
  }
  return out_char(w, '"');
}

/**
 * The first of `%.15g`, `%.16g`, `%.17g` that reads back as exactly `v`, with
 * `.` as the decimal point: `snprintf` writes the process locale's, which may
 * be a comma — a field separator here — or a multibyte character. Whatever
 * sits between the digits that is not a sign or an exponent is that point.
 */
static int format_double(double v, char *buf, size_t size) {
  int n = 0;
  for (int precision = 15; precision <= 17; precision++) {
    n = snprintf(buf, size, "%.*g", precision, v);
    if (strtod(buf, NULL) == v) {
      break;
    }
  }
  int len = 0, point = 0;
  for (int i = 0; i < n; i++) {
    char c = buf[i];
    if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == 'e') {
      buf[len++] = c;
    } else if (!point) {
      buf[len++] = '.';
      point = 1;
    }
  }
  return len;
}

static int out_hex(QueryWork *w, const unsigned char *bytes, size_t n) {
  static const char digits[] = "0123456789abcdef";
  char chunk[1024];
  size_t used = 0;
  for (size_t i = 0; i < n; i++) {
    chunk[used++] = digits[bytes[i] >> 4];
    chunk[used++] = digits[bytes[i] & 15];
    if (used == sizeof(chunk)) {
      if (out_write(w, chunk, used) != 0) {
        return -1;
      }
      used = 0;
    }
  }
  return out_write(w, chunk, used);
}

static int csv_write_header(QueryWork *w) {
  for (int i = 0; i < w->num_columns; i++) {
    const char *name = w->columns[i].name;
    size_t n = strlen(name);
    // A name is made valid UTF-8 like a value (see store_text).
    char *clean = is_ascii(name, n) ? NULL : (char *)malloc(n * 3 + 1);
    if (!is_ascii(name, n) && !clean) {
      snprintf(w->error, sizeof(w->error), "Memory allocation failed for column names");
      return -1;
    }
    if (clean) {
      n = utf8_sanitize((const unsigned char *)name, n, (unsigned char *)clean);
    }
    int rc = (i > 0 && out_char(w, ',') != 0) || out_text_field(w, clean ? clean : name, n) != 0;
    free(clean);
    if (rc) {
      return -1;
    }
  }
  return out_char(w, '\n');
}

/** Write the row held in slot 0 of every column, then empty the slot for the next. */
static int csv_write_row(QueryWork *w) {
  char num[40];
  for (int i = 0; i < w->num_columns; i++) {
    ResultColumn *col = &w->columns[i];
    if (i > 0 && out_char(w, ',') != 0) {
      return -1;
    }
    int rc = 0;
    if (!col->nulls[0]) {
      switch (col->kind) {
        case KIND_INT32: {
          int32_t v;
          memcpy(&v, col->fixed, sizeof(v));
          int len = 0;
          if (v < 0) {
            num[len++] = '-';
          }
          len += write_decimal(num + len, v < 0 ? (uint64_t)0 - (uint64_t)(int64_t)v : (uint64_t)v);
          rc = out_write(w, num, (size_t)len);
          break;
        }
        case KIND_INT64: {
          int64_t v;
          memcpy(&v, col->fixed, sizeof(v));
          int len = 0;
          if (v < 0) {
            num[len++] = '-';
          }
          len += write_decimal(num + len, v < 0 ? (uint64_t)0 - (uint64_t)v : (uint64_t)v);
          rc = out_write(w, num, (size_t)len);
          break;
        }
        case KIND_UINT64: {
          uint64_t v;
          memcpy(&v, col->fixed, sizeof(v));
          rc = out_write(w, num, (size_t)write_decimal(num, v));
          break;
        }
        case KIND_FLOAT64: {
          double v;
          memcpy(&v, col->fixed, sizeof(v));
          rc = out_write(w, num, (size_t)format_double(v, num, sizeof(num)));
          break;
        }
        case KIND_BOOL:
          rc = col->fixed[0] ? out_write(w, "true", 4) : out_write(w, "false", 5);
          break;
        case KIND_TEXT:
          rc = out_text_field(w, col->bytes, col->ends[0]);
          break;
        case KIND_BINARY:
          // Quoted when empty, like an empty string: an empty unquoted field is NULL.
          rc = col->ends[0] == 0 ? out_write(w, "\"\"", 2)
                                 : out_hex(w, (const unsigned char *)col->bytes, col->ends[0]);
          break;
        case KIND_WALLCLOCK:
          // Never chosen for a file: datetimes are written as their canonical text.
          snprintf(w->error, sizeof(w->error), "Internal error: wall-clock column in a CSV file");
          rc = -1;
          break;
      }
    }
    col->bytes_len = 0;
    if (rc != 0) {
      return -1;
    }
  }
  return out_char(w, '\n');
}

static void query_execute(napi_env env, void *data) {
  (void)env;
  QueryWork *w = (QueryWork *)data;

  // No slot means the connection was already closed when the query was
  // submitted; w->conn may be freed, so it must not be touched.
  if (!w->holds_conn) {
    snprintf(w->error, sizeof(w->error), "Connection is closed");
    w->success = 0;
    return;
  }

  // Closed while this work waited in the libuv queue — the slot kept the
  // struct alive, but the caller has abandoned the connection, so do not
  // send the SQL.
  uv_mutex_lock(&w->conn->lock);
  int closing = w->conn->pending_close;
  uv_mutex_unlock(&w->conn->lock);
  if (closing) {
    snprintf(w->error, sizeof(w->error), "Connection is closed");
    w->success = 0;
    work_release_conn(w);
    return;
  }

  // Check if connection is dead.
  if (conn_is_dead(w->conn) || DBDEAD(w->conn->dbproc)) {
    snprintf(w->error, sizeof(w->error), "Connection is dead");
    conn_mark_dead(w->conn);
    w->success = 0;
    work_release_conn(w);
    return;
  }

  clear_error(w->conn);

  if (w->out_path) {
    // Beside the target, so the final rename stays on one file system; unique,
    // so concurrent exports to the same path never share a temporary.
    size_t tmp_size = strlen(w->out_path) + 64;
    w->out_buf = (char *)malloc(OUT_BUF_SIZE);
    w->out_tmp = (char *)malloc(tmp_size);
    if (w->out_buf && w->out_tmp) {
      snprintf(w->out_tmp, tmp_size, "%s.%llx-%p.tmp", w->out_path,
               (unsigned long long)uv_hrtime(), (void *)w);
      w->out = open_output(w->out_tmp);
    }
    if (!w->out) {
      snprintf(w->error, sizeof(w->error), "Could not create %s: %s",
               w->out_tmp ? w->out_tmp : w->out_path,
               w->out_buf && w->out_tmp ? strerror(errno) : "out of memory");
      w->success = 0;
      w->conn_dead = conn_is_dead(w->conn);
      work_release_conn(w);
      return;
    }
  }

  // Spawn the hard-timeout watchdog. Failure is non-fatal — db-lib's own
  // DBSETTIME still provides a cooperative timeout.
  watchdog_start(&w->wd, w->conn, w->hard_timeout_ms);

  // Send SQL command
  if (dbcmd(w->conn->dbproc, w->sql) == FAIL) {
    if (w->conn->has_error) {
      snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
    } else {
      snprintf(w->error, sizeof(w->error), "dbcmd() failed");
    }
    w->success = 0;
    goto done;
  }

  // Execute
  if (dbsqlexec(w->conn->dbproc) == FAIL) {
    if (w->conn->has_error) {
      snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
    } else {
      snprintf(w->error, sizeof(w->error), "dbsqlexec() failed");
    }
    dbcancel(w->conn->dbproc);
    w->success = 0;
    goto done;
  }

  // Process results — skip empty result sets (e.g. from SET ROWCOUNT)
  RETCODE result_code;
  w->affected_rows = 0;
  w->num_columns = 0;
  w->num_rows = 0;
  w->columns = NULL;
  int found_resultset = 0;

  while ((result_code = dbresults(w->conn->dbproc)) != NO_MORE_RESULTS) {
    if (result_code == FAIL) {
      if (w->conn->has_error) {
        snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
      } else {
        snprintf(w->error, sizeof(w->error), "dbresults() failed");
      }
      // A statement-level error (e.g. a duplicate key) fails only that
      // statement: the server goes on with the rest of the batch, whose
      // results are still pending. Left unread, they make the next query on
      // this connection fail with "results pending" (DB-Lib 20019).
      if (!DBDEAD(w->conn->dbproc)) {
        dbcancel(w->conn->dbproc);
      }
      discard_results(w);
      w->success = 0;
      goto done;
    }

    int ncols = dbnumcols(w->conn->dbproc);

    if (ncols <= 0) {
      // DML or SET — accumulate affected counts
      int cnt = DBCOUNT(w->conn->dbproc);
      if (cnt > 0) {
        w->affected_rows += cnt;
      }
      if (discard_rows(w->conn->dbproc) == FAIL) {
        goto rows_failed;
      }
      continue;
    }

    // If we already found a result set, skip subsequent ones
    // (we return the FIRST result set with columns)
    if (found_resultset) {
      if (discard_rows(w->conn->dbproc) == FAIL) {
        goto rows_failed;
      }
      continue;
    }
    found_resultset = 1;

    // Found a result set with columns — read it
    w->num_columns = ncols;
    w->columns = (ResultColumn *)calloc(w->num_columns, sizeof(ResultColumn));
    if (!w->columns) {
      snprintf(w->error, sizeof(w->error), "Memory allocation failed for columns");
      w->num_columns = 0;
      dbcancel(w->conn->dbproc);
      w->success = 0;
      goto done;
    }

    for (int i = 0; i < w->num_columns; i++) {
      const char *colname = dbcolname(w->conn->dbproc, i + 1);
      w->columns[i].name = dup_text(colname ? colname : "", w->conn->latin1);
      w->columns[i].type = column_type(w->conn->dbproc, i + 1);
      w->columns[i].kind = column_kind(w->columns[i].type, w->wall_clock_datetimes);
      // unichar/univarchar (user types 34/35) also report as char types, but
      // FreeTDS has already converted them from UTF-16 to UTF-8.
      int usertype = dbcolutype(w->conn->dbproc, i + 1);
      w->columns[i].latin1 = w->conn->latin1 && usertype != 34 && usertype != 35;
      if (!w->columns[i].name) {
        snprintf(w->error, sizeof(w->error), "Memory allocation failed for column names");
        discard_results(w);
        dbcancel(w->conn->dbproc);
        w->success = 0;
        goto done;
      }
    }

    // Read rows. Streamed to a file, each row is written as soon as it is read
    // and its slot reused, so no default cap is needed: only maxRows limits it.
    int file_mode = w->out != NULL;
    int capacity = file_mode ? 1 : 64;
    w->num_rows = 0;
    int max_rows = w->max_rows > 0 ? w->max_rows : DEFAULT_MAX_ROWS;
    int64_t row_cap = !file_mode ? max_rows : w->max_rows_explicit ? w->max_rows : INT64_MAX;

    if (grow_rows(w->columns, w->num_columns, capacity) != 0) {
      snprintf(w->error, sizeof(w->error), "Memory allocation failed for rows");
      discard_results(w);
      dbcancel(w->conn->dbproc);
      w->success = 0;
      goto done;
    }

    if (file_mode && csv_write_header(w) != 0) {
      discard_results(w);
      dbcancel(w->conn->dbproc);
      w->success = 0;
      goto done;
    }

    RETCODE row_code;
    while ((row_code = dbnextrow(w->conn->dbproc)) != NO_MORE_ROWS) {
      if (row_code == FAIL) {
        if (w->conn->has_error) {
          snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
        } else {
          snprintf(w->error, sizeof(w->error), "dbnextrow() failed");
        }
        discard_results(w);
        dbcancel(w->conn->dbproc);
        w->success = 0;
        goto done;
      }

      // BUF_FULL (row_code > 0 for computed rows) — skip
      if (row_code != REG_ROW) {
        continue;
      }

      // Safety: cap rows
      if ((file_mode ? w->out_rows : w->num_rows) >= row_cap) {
        w->truncated = 1;
        // Drain remaining rows without storing
        if (discard_rows(w->conn->dbproc) == FAIL) {
          goto rows_failed;
        }
        break;
      }

      // Grow arrays if needed
      if (!file_mode && w->num_rows >= capacity) {
        capacity = capacity > max_rows / 2 ? max_rows : capacity * 2;
        if (grow_rows(w->columns, w->num_columns, capacity) != 0) {
          snprintf(w->error, sizeof(w->error), "Memory realloc failed at row %d", w->num_rows);
          discard_results(w);
          dbcancel(w->conn->dbproc);
          w->success = 0;
          goto done;
        }
      }

      // Read column values
      int slot = file_mode ? 0 : w->num_rows;
      for (int i = 0; i < w->num_columns; i++) {
        if (store_cell(w, i, slot) != 0) {
          discard_results(w);
          dbcancel(w->conn->dbproc);
          w->success = 0;
          goto done;
        }
      }
      if (!file_mode) {
        w->num_rows++;
      } else if (csv_write_row(w) == 0) {
        w->out_rows++;
      } else {
        discard_results(w);
        dbcancel(w->conn->dbproc);
        w->success = 0;
        goto done;
      }
    }

    // Capture affected rows for this result set too
    int cnt = DBCOUNT(w->conn->dbproc);
    if (cnt > 0) {
      w->affected_rows += cnt;
    }
  }

  // Rows were dropped without the caller asking for a cap: returning the rest
  // as if it were the whole result would be silently wrong data.
  if (w->truncated && !w->max_rows_explicit) {
    snprintf(w->error, sizeof(w->error),
             "Result exceeded %d rows; pass maxRows to accept a truncated result, "
             "or narrow the query",
             DEFAULT_MAX_ROWS);
    discard_results(w);
    w->success = 0;
    goto done;
  }

  // Any server error (severity > 10) or db-lib error fails the query, even if
  // a result set or affected rows were seen first. Runtime errors such as a
  // conversion failure or divide-by-zero arrive after the column metadata and
  // abort the rest of the batch without making dbresults() return FAIL —
  // reporting success there would hide a failed statement (and, for a
  // paginated select, a skipped trailing `SET ROWCOUNT 0`).
  if (w->conn->has_error) {
    snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
    discard_results(w);
    w->success = 0;
    goto done;
  }

  w->success = 1;
  goto done;

rows_failed:
  // The result stream broke while discarding rows (typically a dead
  // connection). No dbcancel: there is nothing left to cancel on.
  if (w->conn->has_error) {
    snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
  } else {
    snprintf(w->error, sizeof(w->error), "dbnextrow() failed");
  }
  discard_results(w);
  w->success = 0;

done:
  // Write out the rest of the file while the watchdog still covers it.
  if (w->out) {
    if (w->success && out_flush(w) != 0) {
      w->success = 0;
    }
    if (fclose(w->out) != 0 && w->success) {
      snprintf(w->error, sizeof(w->error), "Could not write to %s: %s", w->out_tmp, strerror(errno));
      w->success = 0;
    }
    w->out = NULL;
  }

  // Stop the watchdog before returning. If it already fired (forced cancel),
  // overwrite the error so the JS layer knows it was a hard timeout.
  watchdog_stop(&w->wd);
  if (w->wd.fired) {
    snprintf(w->error, sizeof(w->error),
             "Query exceeded hard timeout of %d ms — connection forcefully cancelled",
             w->hard_timeout_ms);
    discard_results(w);
    w->success = 0;
  }

  // Publish the file, or drop it. Only a complete result replaces the target —
  // a failed query leaves whatever was there before — and not one the caller has
  // given up on: the JS layer closes the connection when its own deadline passes,
  // and a result appearing after the caller was told it failed would be taken
  // for the outcome of a later attempt.
  if (w->out_tmp) {
    // Checked and published under the lock close_connection sets
    // pending_close under: a close either lands first, and nothing is
    // published, or waits for the rename, and the export finished before it.
    uv_mutex_lock(&w->conn->lock);
    if (w->success && w->conn->pending_close) {
      snprintf(w->error, sizeof(w->error), "Connection was closed before the export finished");
      w->success = 0;
    }
    if (w->success && publish_output(w->out_tmp, w->out_path) != 0) {
      snprintf(w->error, sizeof(w->error), "Could not move %s to %s: %s", w->out_tmp, w->out_path,
               strerror(errno));
      w->success = 0;
    }
    uv_mutex_unlock(&w->conn->lock);
    if (!w->success) {
      remove_output(w->out_tmp);
    }
  }

  // Snapshot connection flags before releasing — w->conn may be freed
  // inside conn_release if a close was pending.
  w->conn_dead = conn_is_dead(w->conn);
  w->conn_timed_out = w->conn->timed_out;

  // Release the in-flight slot. If a close was queued while we were running
  // (JS-side hard timeout, pool drain, etc.), this is where the dbproc and
  // the SybaseConnection struct are actually freed. After this call we MUST
  // NOT touch w->conn — query_complete will run on the JS thread but only
  // reads w->error / w->wd.fired / w->success, never w->conn->dbproc.
  work_release_conn(w);
}

#define NAPI_TRY(call)                  \
  do {                                  \
    napi_status try_status_ = (call);   \
    if (try_status_ != napi_ok) {       \
      return try_status_;               \
    }                                   \
  } while (0)

/** Upper bound on the text bytes put in one JS string; see build_text_chunks. */
#define TEXT_CHUNK_BYTES 16384

/** A typed array over a copy of `length` elements of `elem_size` bytes. */
static napi_status copy_typed_array(napi_env env, napi_typedarray_type type, const void *data,
                                    size_t length, size_t elem_size, napi_value *out) {
  void *dest = NULL;
  napi_value buffer;
  NAPI_TRY(napi_create_arraybuffer(env, length * elem_size, &dest, &buffer));
  if (length > 0) {
    memcpy(dest, data, length * elem_size);
  }
  return napi_create_typedarray(env, type, length, buffer, 0, out);
}

/**
 * A text column as an array of strings, each holding consecutive values back
 * to back, for JS to cut by the values' UTF-16 lengths (`units`). One string per
 * value would cost several N-API calls per cell; one string for the whole
 * column could pass V8's string length limit. Bounding the chunks also bounds
 * what a single kept value can hold on to, since V8 may let a value sliced off a
 * string share that string's storage.
 */
static napi_status build_text_chunks(napi_env env, const ResultColumn *col, int num_rows,
                                     napi_value *out) {
  NAPI_TRY(napi_create_array(env, out));
  uint32_t count = 0;
  size_t start = 0;
  for (int r = 0; r < num_rows; r++) {
    size_t end = col->ends[r];
    if (end - start >= TEXT_CHUNK_BYTES || r == num_rows - 1) {
      napi_value chunk;
      NAPI_TRY(napi_create_string_utf8(env, col->bytes + start, end - start, &chunk));
      NAPI_TRY(napi_set_element(env, *out, count++, chunk));
      start = end;
    }
  }
  return napi_ok;
}

/**
 * A binary column as one Buffer holding every value back to back, and a
 * Float64Array of the offset just past each value (exact far beyond 4 GB). JS
 * copies each value out into a Buffer of its own: that is several times cheaper
 * than creating a Buffer per value through N-API.
 */
static napi_status build_binary(napi_env env, const ResultColumn *col, int num_rows,
                                napi_value *bytes_out, napi_value *ends_out) {
  static const char empty[1] = {0};
  NAPI_TRY(napi_create_buffer_copy(env, col->bytes_len, col->bytes_len > 0 ? col->bytes : empty,
                                   NULL, bytes_out));
  void *data = NULL;
  napi_value buffer;
  NAPI_TRY(napi_create_arraybuffer(env, (size_t)num_rows * sizeof(double), &data, &buffer));
  double *ends = (double *)data;
  for (int r = 0; r < num_rows; r++) {
    ends[r] = (double)col->ends[r];
  }
  return napi_create_typedarray(env, napi_float64_array, (size_t)num_rows, buffer, 0, ends_out);
}

/** `{ kind, values, nulls }` for one column (binary adds `ends`); see ValueKind. */
static napi_status build_column(napi_env env, const ResultColumn *col, int num_rows,
                                napi_value *out) {
  napi_value kind, values, nulls;
  size_t n = (size_t)num_rows;
  NAPI_TRY(napi_create_object(env, out));
  NAPI_TRY(napi_create_string_utf8(env, KIND_NAMES[col->kind], NAPI_AUTO_LENGTH, &kind));
  NAPI_TRY(napi_set_named_property(env, *out, "kind", kind));

  switch (col->kind) {
    case KIND_TEXT: {
      napi_value units;
      NAPI_TRY(build_text_chunks(env, col, num_rows, &values));
      NAPI_TRY(copy_typed_array(env, napi_uint32_array, col->units, n, sizeof(uint32_t), &units));
      NAPI_TRY(napi_set_named_property(env, *out, "units", units));
      break;
    }
    case KIND_BINARY: {
      napi_value ends;
      NAPI_TRY(build_binary(env, col, num_rows, &values, &ends));
      NAPI_TRY(napi_set_named_property(env, *out, "ends", ends));
      break;
    }
    case KIND_INT32:
      NAPI_TRY(copy_typed_array(env, napi_int32_array, col->fixed, n, sizeof(int32_t), &values));
      break;
    case KIND_FLOAT64:
    case KIND_WALLCLOCK:
      NAPI_TRY(copy_typed_array(env, napi_float64_array, col->fixed, n, sizeof(double), &values));
      break;
    case KIND_INT64:
      NAPI_TRY(copy_typed_array(env, napi_bigint64_array, col->fixed, n, sizeof(int64_t), &values));
      break;
    case KIND_UINT64:
      NAPI_TRY(
          copy_typed_array(env, napi_biguint64_array, col->fixed, n, sizeof(uint64_t), &values));
      break;
    case KIND_BOOL:
      NAPI_TRY(copy_typed_array(env, napi_uint8_array, col->fixed, n, 1, &values));
      break;
  }
  NAPI_TRY(napi_set_named_property(env, *out, "values", values));

  if (col->has_nulls) {
    NAPI_TRY(copy_typed_array(env, napi_uint8_array, col->nulls, n, 1, &nulls));
  } else {
    NAPI_TRY(napi_get_undefined(env, &nulls));
  }
  return napi_set_named_property(env, *out, "nulls", nulls);
}

/**
 * `{ columns, columnTypes, data, rowCount, affectedRows }`; for a result
 * streamed to a file, `{ columns, columnTypes, rowCount, affectedRows, bytes }`.
 */
static napi_status build_result(napi_env env, const QueryWork *w, napi_value *out) {
  napi_value cols_arr, col_types_arr, data_arr, row_count, affected;
  size_t ncols = (size_t)w->num_columns;
  NAPI_TRY(napi_create_object(env, out));
  NAPI_TRY(napi_create_array_with_length(env, ncols, &cols_arr));
  NAPI_TRY(napi_create_array_with_length(env, ncols, &col_types_arr));
  NAPI_TRY(napi_create_array_with_length(env, ncols, &data_arr));

  // Column names, Sybase type names and values, in column order
  for (int i = 0; i < w->num_columns; i++) {
    napi_value col_name, col_type, col_data;
    NAPI_TRY(napi_create_string_utf8(env, w->columns[i].name, NAPI_AUTO_LENGTH, &col_name));
    NAPI_TRY(napi_set_element(env, cols_arr, (uint32_t)i, col_name));
    NAPI_TRY(napi_create_string_utf8(env, syb_type_name(w->columns[i].type), NAPI_AUTO_LENGTH,
                                     &col_type));
    NAPI_TRY(napi_set_element(env, col_types_arr, (uint32_t)i, col_type));
    if (!w->out_path) {
      NAPI_TRY(build_column(env, &w->columns[i], w->num_rows, &col_data));
      NAPI_TRY(napi_set_element(env, data_arr, (uint32_t)i, col_data));
    }
  }

  if (w->out_path) {
    // Past int32 for a large file; exact in a double far beyond any row count.
    napi_value bytes;
    NAPI_TRY(napi_create_double(env, (double)w->out_rows, &row_count));
    NAPI_TRY(napi_create_double(env, (double)w->out_bytes, &bytes));
    NAPI_TRY(napi_set_named_property(env, *out, "bytes", bytes));
  } else {
    NAPI_TRY(napi_create_int32(env, w->num_rows, &row_count));
    NAPI_TRY(napi_set_named_property(env, *out, "data", data_arr));
  }
  NAPI_TRY(napi_create_int32(env, w->affected_rows, &affected));
  NAPI_TRY(napi_set_named_property(env, *out, "columns", cols_arr));
  NAPI_TRY(napi_set_named_property(env, *out, "columnTypes", col_types_arr));
  NAPI_TRY(napi_set_named_property(env, *out, "rowCount", row_count));
  return napi_set_named_property(env, *out, "affectedRows", affected);
}

static void query_complete(napi_env env, napi_status status, void *data) {
  QueryWork *w = (QueryWork *)data;

  if (status == napi_cancelled || !w->success) {
    napi_value error_msg, error_obj;
    napi_create_string_utf8(env, w->error, NAPI_AUTO_LENGTH, &error_msg);
    napi_create_error(env, NULL, error_msg, &error_obj);

    if (w->conn_dead) {
      napi_value dead_val;
      napi_get_boolean(env, true, &dead_val);
      napi_set_named_property(env, error_obj, "connectionDead", dead_val);
    }

    if (w->conn_timed_out) {
      napi_value to_val;
      napi_get_boolean(env, true, &to_val);
      napi_set_named_property(env, error_obj, "timedOut", to_val);
    }

    if (w->wd.fired) {
      napi_value forced_val;
      napi_get_boolean(env, true, &forced_val);
      napi_set_named_property(env, error_obj, "hardTimeout", forced_val);
    }

    napi_reject_deferred(env, w->deferred, error_obj);
  } else {
    napi_value result;
    if (build_result(env, w, &result) == napi_ok) {
      napi_resolve_deferred(env, w->deferred, result);
    } else {
      // Typically V8 running out of memory for a very large result.
      bool pending = false;
      napi_value error_obj;
      napi_is_exception_pending(env, &pending);
      if (pending) {
        napi_get_and_clear_last_exception(env, &error_obj);
      } else {
        napi_value error_msg;
        napi_create_string_utf8(env, "Could not hand the query result to JavaScript",
                                NAPI_AUTO_LENGTH, &error_msg);
        napi_create_error(env, NULL, error_msg, &error_obj);
      }
      napi_reject_deferred(env, w->deferred, error_obj);
    }
  }

  // Cleanup — always runs regardless of success/failure
  // A cancelled work item never ran query_execute, so its slot is still held.
  work_release_conn(w);
  free_columns(w->columns, w->num_columns);
  free(w->sql);
  free(w->out_path);
  free(w->out_tmp);
  free(w->out_buf);
  napi_delete_async_work(env, w->work);
  free(w);
}

/**
 * The SQL text as bytes for dbcmd: UTF-8, or Latin-1 for a Latin-1 server.
 *
 * A character Latin-1 cannot hold is refused rather than sent: it would reach
 * the server as two or more unrelated characters. The query builders and
 * `serializeValue` write such strings as `U&'...'` literals, which carry any
 * character in ASCII escapes. Returns NULL with an exception pending.
 */
static char *sql_bytes(napi_env env, napi_value value, int latin1) {
  size_t len = 0;
  if (!latin1) {
    napi_get_value_string_utf8(env, value, NULL, 0, &len);
    char *out = (char *)malloc(len + 1);
    if (!out) {
      napi_throw_error(env, NULL, "Out of memory");
      return NULL;
    }
    napi_get_value_string_utf8(env, value, out, len + 1, &len);
    return out;
  }
  napi_get_value_string_utf16(env, value, NULL, 0, &len);
  char16_t *units = (char16_t *)malloc((len + 1) * sizeof(char16_t));
  char *out = units ? (char *)malloc(len + 1) : NULL;
  if (!out) {
    free(units);
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  napi_get_value_string_utf16(env, value, units, len + 1, &len);
  for (size_t i = 0; i < len; i++) {
    if (units[i] > 0xFF) {
      char message[400];
      snprintf(message, sizeof(message),
               "The SQL contains U+%04X at offset %zu, which the server's character set (iso_1) "
               "cannot hold. Write such text as a U&'...' literal (e.g. U&'\\%04x'); the query "
               "builders and serializeValue do this for string values.",
               (unsigned)units[i], i, (unsigned)units[i]);
      free(units);
      free(out);
      napi_throw_range_error(env, NULL, message);
      return NULL;
    }
    out[i] = (char)units[i];
  }
  out[len] = '\0';
  free(units);
  return out;
}

// napi_value query(conn, sql, options?)
//
// options.maxRows: cap rows materialized into JS (defaults to 1,000,000).
// options.hardTimeoutMs: hard kill threshold for stuck queries. If unset
//   we derive it from the connection's timeout (2x timeout, min 30s).
// options.wallClockDateTimes: hand datetime/smalldatetime over as wall-clock
//   numbers ("wallclock" kind) instead of canonical text.
// options.outputPath: stream the rows to this CSV file instead (see
//   csv_write_row); the result then carries no data, and `bytes`.
//
// Resolves to the result column by column — see build_result; the JS layer
// (src/native/index.ts) turns it into rows.
static napi_value fn_query(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  ConnHandle *handle = get_conn_handle(env, args[0]);
  if (handle == NULL) {
    return NULL;  // TypeError pending
  }

  napi_valuetype sql_type = napi_undefined;
  if (argc < 2 || napi_typeof(env, args[1], &sql_type) != napi_ok || sql_type != napi_string) {
    napi_throw_type_error(env, NULL, "Expected the SQL as a string");
    return NULL;
  }
  // The SQL goes to the server in its own character set (see SybaseConnection.latin1).
  char *sql = sql_bytes(env, args[1], handle->conn != NULL && handle->conn->latin1);
  if (sql == NULL) {
    return NULL;  // error pending
  }

  QueryWork *w = (QueryWork *)calloc(1, sizeof(QueryWork));
  if (w == NULL) {
    free(sql);
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  w->sql = sql;

  // A closed handle has no connection: the query is rejected as on a closed
  // connection (holds_conn stays 0 below).
  w->conn = handle->conn;

  // Defaults
  w->max_rows = DEFAULT_MAX_ROWS;
  // Hard timeout: 2x the cooperative timeout, with a 30s floor so very small
  // configured timeouts don't translate to absurdly tight watchdog deadlines.
  int base_timeout_s = (w->conn && w->conn->timeout_seconds > 0)
                           ? w->conn->timeout_seconds
                           : 30;
  w->hard_timeout_ms = base_timeout_s * 2 * 1000;
  if (w->hard_timeout_ms < 30000) {
    w->hard_timeout_ms = 30000;
  }

  if (argc >= 3) {
    napi_valuetype vtype;
    napi_typeof(env, args[2], &vtype);
    if (vtype == napi_object) {
      napi_value v;

      napi_get_named_property(env, args[2], "maxRows", &v);
      napi_typeof(env, v, &vtype);
      if (vtype == napi_number) {
        int32_t requested = 0;
        napi_get_value_int32(env, v, &requested);
        if (requested > 0) {
          w->max_rows = requested;
          w->max_rows_explicit = 1;
        }
      }

      napi_get_named_property(env, args[2], "hardTimeoutMs", &v);
      napi_typeof(env, v, &vtype);
      if (vtype == napi_number) {
        napi_get_value_int32(env, v, &w->hard_timeout_ms);
      }

      napi_get_named_property(env, args[2], "wallClockDateTimes", &v);
      napi_typeof(env, v, &vtype);
      if (vtype == napi_boolean) {
        bool flag = false;
        napi_get_value_bool(env, v, &flag);
        w->wall_clock_datetimes = flag ? 1 : 0;
      }

      napi_get_named_property(env, args[2], "outputPath", &v);
      napi_typeof(env, v, &vtype);
      if (vtype == napi_string) {
        size_t path_len = 0;
        napi_get_value_string_utf8(env, v, NULL, 0, &path_len);
        // Validated by the JS wrapper (non-empty, no NUL), its only caller.
        w->out_path = (char *)malloc(path_len + 1);
        if (w->out_path == NULL) {
          free(w->sql);
          free(w);
          napi_throw_error(env, NULL, "Out of memory");
          return NULL;
        }
        napi_get_value_string_utf8(env, v, w->out_path, path_len + 1, &path_len);
        // Datetimes go to the file as their canonical text.
        w->wall_clock_datetimes = 0;
      }
    }
  }

  napi_value promise;
  napi_create_promise(env, &w->deferred, &promise);

  // Pin the connection now, on the JS thread, rather than when a worker picks
  // the job up: fn_close only defers the free while in_flight > 0, and the
  // job may sit in the libuv queue behind other queries for a long time.
  w->holds_conn = (w->conn != NULL && conn_acquire(w->conn) == 0);

  napi_value work_name;
  napi_create_string_utf8(env, "sybase_query", NAPI_AUTO_LENGTH, &work_name);
  napi_status st = napi_create_async_work(env, NULL, work_name, query_execute, query_complete,
                                          w, &w->work);
  if (st == napi_ok) {
    st = napi_queue_async_work(env, w->work);
    if (st != napi_ok) {
      napi_delete_async_work(env, w->work);
    }
  }
  if (st != napi_ok) {
    // query_complete will never run, so undo here what it would have:
    // release the connection slot, settle the promise and free the work.
    work_release_conn(w);
    napi_value msg, err;
    napi_create_string_utf8(env, "Failed to schedule query", NAPI_AUTO_LENGTH, &msg);
    napi_create_error(env, NULL, msg, &err);
    napi_reject_deferred(env, w->deferred, err);
    free(w->sql);
    free(w->out_path);
    free(w);
  }

  return promise;
}

// ---------------------------------------------------------------------------
// Close connection
// ---------------------------------------------------------------------------

// fn_close: deferred-safe close.
//
// If a query worker is currently running on this connection (e.g. JS layer
// gave up on a hard timeout but the C-level dbnextrow is still blocked), we
// do NOT free dbproc here — that would be a use-after-free in the worker.
// Instead we set pending_close; conn_release in the worker will perform the
// actual destruction once it returns.
//
// We deliberately do NOT call dbcancel from this thread either: dbcancel
// invokes tds_process_cancel which reads from the same socket the worker
// is reading from. We rely on db-lib's per-connection DBSETTIME to abort
// the worker; if the user wants tighter behavior they must configure a
// smaller `timeout` rather than a smaller hardTimeoutMs.
static napi_value fn_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  ConnHandle *handle = get_conn_handle(env, args[0]);
  if (handle == NULL) {
    return NULL;  // TypeError pending
  }
  // Closing twice is a no-op: the second call finds no connection.
  if (handle->conn) {
    SybaseConnection *conn = handle->conn;
    handle->conn = NULL;
    close_connection(conn);
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// ---------------------------------------------------------------------------
// Check if connection is alive
// ---------------------------------------------------------------------------

static napi_value fn_is_alive(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  ConnHandle *handle = get_conn_handle(env, args[0]);
  if (handle == NULL) {
    return NULL;  // TypeError pending
  }
  SybaseConnection *conn = handle->conn;

  int alive = 0;
  if (conn) {
    uv_mutex_lock(&conn->lock);
    if (conn->dbproc && !conn->dead && !conn->pending_close && !DBDEAD(conn->dbproc)) {
      alive = 1;
    }
    uv_mutex_unlock(&conn->lock);
  }

  napi_value result;
  napi_get_boolean(env, alive, &result);
  return result;
}

// ---------------------------------------------------------------------------
// Server character set
// ---------------------------------------------------------------------------

/** The server's default character set name, or "" for a closed handle. */
static napi_value fn_server_charset(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  ConnHandle *handle = get_conn_handle(env, args[0]);
  if (handle == NULL) {
    return NULL;  // TypeError pending
  }
  napi_value result;
  napi_create_string_utf8(env, handle->conn ? handle->conn->charset : "", NAPI_AUTO_LENGTH, &result);
  return result;
}

// ---------------------------------------------------------------------------
// Get version
// ---------------------------------------------------------------------------

static napi_value fn_get_version(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  char version[128];
  snprintf(version, sizeof(version), "FreeTDS %s (db-lib)", dbversion());
  napi_create_string_utf8(env, version, NAPI_AUTO_LENGTH, &result);
  return result;
}

// ---------------------------------------------------------------------------
// Module initialization
// ---------------------------------------------------------------------------

static napi_value init(napi_env env, napi_value exports) {
  uv_once(&global_init_once, init_globals);

  if (dbinit() == FAIL) {
    napi_throw_error(env, NULL, "FreeTDS dbinit() failed");
    return exports;
  }

  // Install per-process error/message handlers
  dberrhandle(err_handler);
  dbmsghandle(msg_handler);

  napi_value fn;

  napi_create_function(env, "connect", 0, fn_connect, NULL, &fn);
  napi_set_named_property(env, exports, "connect", fn);

  napi_create_function(env, "query", 0, fn_query, NULL, &fn);
  napi_set_named_property(env, exports, "query", fn);

  napi_create_function(env, "close", 0, fn_close, NULL, &fn);
  napi_set_named_property(env, exports, "close", fn);

  napi_create_function(env, "isAlive", 0, fn_is_alive, NULL, &fn);
  napi_set_named_property(env, exports, "isAlive", fn);

  napi_create_function(env, "serverCharset", 0, fn_server_charset, NULL, &fn);
  napi_set_named_property(env, exports, "serverCharset", fn);

  napi_create_function(env, "getVersion", 0, fn_get_version, NULL, &fn);
  napi_set_named_property(env, exports, "getVersion", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
