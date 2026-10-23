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
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

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
      snprintf(conn->last_error + cur_len, ERR_BUF_SIZE - cur_len,
               "Msg %ld, Level %d, State %d: %s\n",
               (long)msgno, severity, msgstate, msgtext);
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

typedef struct {
  char *name;
  char **values;
  // Byte length per value; allocated only for binary columns, whose values
  // are raw bytes (may contain NUL) rather than NUL-terminated text.
  int *lengths;
  int type;
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

static void free_columns(ResultColumn *columns, int num_columns, int num_rows) {
  if (!columns) {
    return;
  }
  for (int i = 0; i < num_columns; i++) {
    if (columns[i].values) {
      for (int r = 0; r < num_rows; r++) {
        free(columns[i].values[r]);
      }
      free(columns[i].values);
    }
    free(columns[i].lengths);
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
      free_columns(w->columns, w->num_columns, w->num_rows);
      w->columns = NULL;
      w->num_columns = 0;
      w->num_rows = 0;
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
      dbcancel(w->conn->dbproc);
      w->success = 0;
      goto done;
    }

    for (int i = 0; i < w->num_columns; i++) {
      const char *colname = dbcolname(w->conn->dbproc, i + 1);
      w->columns[i].name = strdup(colname ? colname : "");
      w->columns[i].type = column_type(w->conn->dbproc, i + 1);
      w->columns[i].values = NULL;
      if (!w->columns[i].name) {
        snprintf(w->error, sizeof(w->error), "Memory allocation failed for column names");
        free_columns(w->columns, w->num_columns, 0);
        w->columns = NULL;
        w->num_columns = 0;
        dbcancel(w->conn->dbproc);
        w->success = 0;
        goto done;
      }
    }

    // Read rows
    int capacity = 64;
    w->num_rows = 0;
    int max_rows = w->max_rows > 0 ? w->max_rows : DEFAULT_MAX_ROWS;

    for (int i = 0; i < w->num_columns; i++) {
      w->columns[i].values = (char **)calloc(capacity, sizeof(char *));
      if (w->columns[i].values && is_binary_type(w->columns[i].type)) {
        w->columns[i].lengths = (int *)calloc(capacity, sizeof(int));
      }
      if (!w->columns[i].values ||
          (is_binary_type(w->columns[i].type) && !w->columns[i].lengths)) {
        snprintf(w->error, sizeof(w->error), "Memory allocation failed for rows");
        free_columns(w->columns, w->num_columns, w->num_rows);
        w->columns = NULL;
        w->num_columns = 0;
        w->num_rows = 0;
        dbcancel(w->conn->dbproc);
        w->success = 0;
        goto done;
      }
    }

    RETCODE row_code;
    while ((row_code = dbnextrow(w->conn->dbproc)) != NO_MORE_ROWS) {
      if (row_code == FAIL) {
        if (w->conn->has_error) {
          snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
        } else {
          snprintf(w->error, sizeof(w->error), "dbnextrow() failed");
        }
        free_columns(w->columns, w->num_columns, w->num_rows);
        w->columns = NULL;
        w->num_columns = 0;
        w->num_rows = 0;
        dbcancel(w->conn->dbproc);
        w->success = 0;
        goto done;
      }

      // BUF_FULL (row_code > 0 for computed rows) — skip
      if (row_code != REG_ROW) {
        continue;
      }

      // Safety: cap rows
      if (w->num_rows >= max_rows) {
        w->truncated = 1;
        // Drain remaining rows without storing
        if (discard_rows(w->conn->dbproc) == FAIL) {
          goto rows_failed;
        }
        break;
      }

      // Grow arrays if needed
      if (w->num_rows >= capacity) {
        capacity *= 2;
        if (capacity > max_rows) {
          capacity = max_rows;
        }
        for (int i = 0; i < w->num_columns; i++) {
          char **new_vals = (char **)realloc(w->columns[i].values, capacity * sizeof(char *));
          if (!new_vals) {
            snprintf(w->error, sizeof(w->error), "Memory realloc failed at row %d", w->num_rows);
            free_columns(w->columns, w->num_columns, w->num_rows);
            w->columns = NULL;
            w->num_columns = 0;
            w->num_rows = 0;
            dbcancel(w->conn->dbproc);
            w->success = 0;
            goto done;
          }
          w->columns[i].values = new_vals;
          if (w->columns[i].lengths) {
            int *new_lens = (int *)realloc(w->columns[i].lengths, capacity * sizeof(int));
            if (!new_lens) {
              snprintf(w->error, sizeof(w->error), "Memory realloc failed at row %d", w->num_rows);
              free_columns(w->columns, w->num_columns, w->num_rows);
              w->columns = NULL;
              w->num_columns = 0;
              w->num_rows = 0;
              dbcancel(w->conn->dbproc);
              w->success = 0;
              goto done;
            }
            w->columns[i].lengths = new_lens;
          }
        }
      }

      // Clear this row's slots first: realloc'd storage is uninitialized, and a
      // failure partway through the row frees it with `num_rows + 1`, which
      // must only see the values actually stored so far.
      for (int i = 0; i < w->num_columns; i++) {
        w->columns[i].values[w->num_rows] = NULL;
      }

      // Read column values
      for (int i = 0; i < w->num_columns; i++) {
        int col = i + 1;
        int datalen = dbdatlen(w->conn->dbproc, col);

        if (datalen == 0 && dbdata(w->conn->dbproc, col) == NULL) {
          w->columns[i].values[w->num_rows] = NULL;
        } else if (w->columns[i].lengths) {
          // Binary: keep the raw bytes. Converting to SYBCHAR would hand JS a
          // hex string, which is neither what the schema declares nor what a
          // write of the same value produces.
          char *bytes = (char *)malloc(datalen > 0 ? (size_t)datalen : 1);
          if (!bytes) {
            snprintf(w->error, sizeof(w->error), "Memory allocation failed for column value");
            free_columns(w->columns, w->num_columns, w->num_rows + 1);
            w->columns = NULL;
            w->num_columns = 0;
            w->num_rows = 0;
            dbcancel(w->conn->dbproc);
            w->success = 0;
            goto done;
          }
          if (datalen > 0) {
            memcpy(bytes, dbdata(w->conn->dbproc, col), (size_t)datalen);
          }
          w->columns[i].values[w->num_rows] = bytes;
          w->columns[i].lengths[w->num_rows] = datalen;
        } else {
          int coltype = dbcoltype(w->conn->dbproc, col);
          BYTE *src = dbdata(w->conn->dbproc, col);

          // Dynamically size buffer: most conversions expand by at most 2x,
          // but use at least 8192 to handle small columns without extra allocs.
          int buf_size = datalen > 4096 ? (datalen * 2 + 64) : 8192;
          char stack_buf[8192];
          char *buf = (buf_size <= 8192) ? stack_buf : (char *)malloc(buf_size);
          if (!buf) {
            snprintf(w->error, sizeof(w->error), "Memory allocation failed for column value");
            free_columns(w->columns, w->num_columns, w->num_rows + 1);
            w->columns = NULL;
            w->num_columns = 0;
            w->num_rows = 0;
            dbcancel(w->conn->dbproc);
            w->success = 0;
            goto done;
          }

          int convlen;
          if (is_temporal_type(coltype)) {
            // Date/time values are formatted here, never by dbconvert, which
            // renders them through a locale-dependent format string that in
            // several locales drops the seconds and milliseconds outright — see
            // format_temporal_value. There is deliberately no fallback: falling
            // back would reintroduce exactly the lossy, machine-dependent text
            // this exists to remove, and the JS layer would then be handed a
            // string it cannot parse. Failing the query says so directly.
            convlen = datalen > 0
                          ? format_temporal_value(w->conn->dbproc, coltype, src, buf,
                                                  (size_t)buf_size)
                          : -1;
            if (convlen < 0) {
              snprintf(w->error, sizeof(w->error),
                       "Could not decode %s column '%s' (%d bytes) into canonical text",
                       syb_type_name(coltype), w->columns[i].name ? w->columns[i].name : "?",
                       datalen);
              if (buf != stack_buf) {
                free(buf);
              }
              free_columns(w->columns, w->num_columns, w->num_rows + 1);
              w->columns = NULL;
              w->num_columns = 0;
              w->num_rows = 0;
              dbcancel(w->conn->dbproc);
              w->success = 0;
              goto done;
            }
          } else {
            convlen = dbconvert(w->conn->dbproc, coltype, src, datalen,
                                SYBCHAR, (BYTE *)buf, buf_size - 1);
          }
          if (convlen >= 0) {
            buf[convlen] = '\0';
            // Trim trailing spaces for CHAR/NCHAR fixed-width types
            if (coltype == SYBCHAR) {
              while (convlen > 0 && buf[convlen - 1] == ' ') {
                buf[--convlen] = '\0';
              }
            }
            w->columns[i].values[w->num_rows] = strdup(buf);
          } else {
            w->columns[i].values[w->num_rows] = strdup("");
          }

          if (buf != stack_buf) {
            free(buf);
          }

          // A NULL here would be read back as SQL NULL — silently wrong data.
          if (!w->columns[i].values[w->num_rows]) {
            snprintf(w->error, sizeof(w->error), "Memory allocation failed for column value");
            free_columns(w->columns, w->num_columns, w->num_rows + 1);
            w->columns = NULL;
            w->num_columns = 0;
            w->num_rows = 0;
            dbcancel(w->conn->dbproc);
            w->success = 0;
            goto done;
          }
        }
      }
      w->num_rows++;
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
    free_columns(w->columns, w->num_columns, w->num_rows);
    w->columns = NULL;
    w->num_columns = 0;
    w->num_rows = 0;
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
    free_columns(w->columns, w->num_columns, w->num_rows);
    w->columns = NULL;
    w->num_columns = 0;
    w->num_rows = 0;
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
  free_columns(w->columns, w->num_columns, w->num_rows);
  w->columns = NULL;
  w->num_columns = 0;
  w->num_rows = 0;
  w->success = 0;

done:
  // Stop the watchdog before returning. If it already fired (forced cancel),
  // overwrite the error so the JS layer knows it was a hard timeout.
  watchdog_stop(&w->wd);
  if (w->wd.fired) {
    snprintf(w->error, sizeof(w->error),
             "Query exceeded hard timeout of %d ms — connection forcefully cancelled",
             w->hard_timeout_ms);
    free_columns(w->columns, w->num_columns, w->num_rows);
    w->columns = NULL;
    w->num_columns = 0;
    w->num_rows = 0;
    w->success = 0;
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
    // Build result object
    napi_value result, rows_arr, cols_arr, col_types_arr, row_count, affected;

    napi_create_object(env, &result);
    napi_create_array_with_length(env, w->num_rows, &rows_arr);
    napi_create_array_with_length(env, w->num_columns, &cols_arr);
    napi_create_array_with_length(env, w->num_columns, &col_types_arr);

    // Column names and Sybase type names, in column order
    for (int i = 0; i < w->num_columns; i++) {
      napi_value col_name, col_type;
      napi_create_string_utf8(env, w->columns[i].name, NAPI_AUTO_LENGTH, &col_name);
      napi_set_element(env, cols_arr, i, col_name);
      napi_create_string_utf8(env, syb_type_name(w->columns[i].type), NAPI_AUTO_LENGTH, &col_type);
      napi_set_element(env, col_types_arr, i, col_type);
    }

    // Row objects with type-aware conversion
    for (int r = 0; r < w->num_rows; r++) {
      napi_value row;
      napi_create_object(env, &row);

      for (int c = 0; c < w->num_columns; c++) {
        napi_value key, val;
        napi_create_string_utf8(env, w->columns[c].name, NAPI_AUTO_LENGTH, &key);

        if (w->columns[c].values[r] == NULL) {
          napi_get_null(env, &val);
        } else if (w->columns[c].lengths) {
          napi_create_buffer_copy(env, (size_t)w->columns[c].lengths[r],
                                  w->columns[c].values[r], NULL, &val);
        } else {
          int coltype = w->columns[c].type;
          char *strval = w->columns[c].values[r];

          if (coltype == SYBINT1 || coltype == SYBINT2 || coltype == SYBINT4) {
            int intval = atoi(strval);
            napi_create_int32(env, intval, &val);
          } else if (coltype == SYBINT8) {
            // bigint is 64-bit: up to 9223372036854775807, which a double
            // cannot hold. A double silently rounds anything past 2^53
            // (9007199254740993 reads back as 9007199254740992), so the value
            // is handed over as a BigInt — the only exact JS integer type.
            // Mixing a BigInt into number arithmetic throws rather than
            // corrupting the result, which is the behaviour we want here.
            long long llval = atoll(strval);
            napi_create_bigint_int64(env, llval, &val);
          } else if (coltype == TDS_USMALLINT || coltype == TDS_UINT) {
            // Up to 4294967295: past int32, but exact in a double.
            napi_create_double(env, (double)strtoul(strval, NULL, 10), &val);
          } else if (coltype == TDS_UBIGINT) {
            // Up to 18446744073709551615 — past even int64, so a uint64 BigInt.
            napi_create_bigint_uint64(env, (uint64_t)strtoull(strval, NULL, 10), &val);
          } else if (coltype == SYBFLT8 || coltype == SYBREAL) {
            double dval = atof(strval);
            napi_create_double(env, dval, &val);
          } else if (coltype == SYBMONEY || coltype == SYBMONEY4 ||
                     coltype == SYBNUMERIC || coltype == SYBDECIMAL) {
            // Money and decimal: return as string to preserve precision
            // (JavaScript number loses precision beyond ~15 digits)
            napi_create_string_utf8(env, strval, NAPI_AUTO_LENGTH, &val);
          } else if (coltype == SYBBIT) {
            int bval = atoi(strval);
            napi_get_boolean(env, bval != 0, &val);
          } else {
            napi_create_string_utf8(env, strval, NAPI_AUTO_LENGTH, &val);
          }
        }

        napi_set_property(env, row, key, val);
      }
      napi_set_element(env, rows_arr, r, row);
    }

    napi_create_int32(env, w->num_rows, &row_count);
    napi_create_int32(env, w->affected_rows, &affected);

    napi_value key_rows, key_cols, key_col_types, key_rc, key_aff;
    napi_create_string_utf8(env, "rows", NAPI_AUTO_LENGTH, &key_rows);
    napi_create_string_utf8(env, "columns", NAPI_AUTO_LENGTH, &key_cols);
    napi_create_string_utf8(env, "columnTypes", NAPI_AUTO_LENGTH, &key_col_types);
    napi_create_string_utf8(env, "rowCount", NAPI_AUTO_LENGTH, &key_rc);
    napi_create_string_utf8(env, "affectedRows", NAPI_AUTO_LENGTH, &key_aff);

    napi_set_property(env, result, key_rows, rows_arr);
    napi_set_property(env, result, key_cols, cols_arr);
    napi_set_property(env, result, key_col_types, col_types_arr);
    napi_set_property(env, result, key_rc, row_count);
    napi_set_property(env, result, key_aff, affected);

    napi_resolve_deferred(env, w->deferred, result);
  }

  // Cleanup — always runs regardless of success/failure
  // A cancelled work item never ran query_execute, so its slot is still held.
  work_release_conn(w);
  free_columns(w->columns, w->num_columns, w->num_rows);
  free(w->sql);
  napi_delete_async_work(env, w->work);
  free(w);
}

// napi_value query(conn, sql, options?)
//
// options.maxRows: cap rows materialized into JS (defaults to 1,000,000).
// options.hardTimeoutMs: hard kill threshold for stuck queries. If unset
//   we derive it from the connection's timeout (2x timeout, min 30s).
static napi_value fn_query(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  ConnHandle *handle = get_conn_handle(env, args[0]);
  if (handle == NULL) {
    return NULL;  // TypeError pending
  }

  size_t sql_len = 0;
  if (argc < 2 || napi_get_value_string_utf8(env, args[1], NULL, 0, &sql_len) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected the SQL as a string");
    return NULL;
  }

  QueryWork *w = (QueryWork *)calloc(1, sizeof(QueryWork));
  char *sql = (char *)malloc(sql_len + 1);
  if (w == NULL || sql == NULL) {
    free(w);
    free(sql);
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  w->sql = sql;
  napi_get_value_string_utf8(env, args[1], w->sql, sql_len + 1, &sql_len);

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

  napi_create_function(env, "getVersion", 0, fn_get_version, NULL, &fn);
  napi_set_named_property(env, exports, "getVersion", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
