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
 *     `hardTimeoutMs` (default 2 * timeout_seconds, min 30s, counted from when
 *     the call was queued) marks the connection dead. The worker then stops: it
 *     checks between rows, and db-lib's interrupt handler ends a wait within
 *     about a second. The promise settles when the worker returns — it is the
 *     JS layer (SybaseConnection) that rejects on schedule whatever the worker
 *     does.
 *
 *     The watchdog deliberately does NOT call dbcancel() from its thread:
 *     dbcancel() invokes tds_process_cancel() which reads from the same
 *     socket the worker is reading from, racing with the worker's own
 *     dbnextrow().
 *   - Deferred close: fn_close detects in-flight queries (via in_flight
 *     counter) and instead of freeing immediately, sets pending_close.
 *     conn_release in the worker performs the actual destruction, eliminating
 *     the use-after-free that would otherwise happen when the JS layer
 *     abandons a stuck connection.
 *   - Concurrency self-protection: a call is refused while another is queued
 *     or running on the same handle (ConnHandle.busy) — db-lib's DBPROCESS
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
#include <float.h>
#include <limits.h>
#include <math.h>
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

/** Longest user name the TDS 5.0 login record holds, in bytes (FreeTDS TDS_MAXNAME). */
#define LOGIN_USER_MAX 30
/** Longest password db-lib takes, in bytes (FreeTDS TDS_MAX_LOGIN_STR_SZ). */
#define LOGIN_PASSWORD_MAX 128

/** Largest timeout, in seconds, whose derived hard timeout (2x, in ms) fits an int. */
#define MAX_TIMEOUT_SECONDS (INT32_MAX / 2000)

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

static int err_handler(DBPROCESS *dbproc, int severity, int dberr, int oserr, char *dberrstr,
                       char *oserrstr);
static int msg_handler(DBPROCESS *dbproc, DBINT msgno, int msgstate, int severity, char *msgtext,
                       char *srvname, char *procname, int line);

/** Whether db-lib initialised; set once, by init_globals. */
static int dblib_ready = 0;

/**
 * Once per process, whatever the number of Node environments (worker threads)
 * loading the addon. dbinit() first resets db-lib's error handler to its
 * default — which exits the process on a timeout or a dead connection — so it
 * must not run again while another thread's calls may hit an error.
 */
static void init_globals(void) {
  if (uv_mutex_init(&login_mutex) != 0) {
    return;  // not ready: every connect needs the mutex
  }
  if (dbinit() == FAIL) {
    return;
  }
  dberrhandle(err_handler);
  dbmsghandle(msg_handler);
  dblib_ready = 1;
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
  int last_dberr;       // number of the last db-lib (not server) error, 0 if none
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
  // Set between bulkBegin and the end of the copy: the DBPROCESS is then in the
  // middle of a bulk copy and takes nothing else (see the bulk copy section).
  struct BulkState *bulk;
} SybaseConnection;

// Forward declarations.
static void destroy_connection(SybaseConnection *conn);
static void bulk_state_free(struct BulkState *state);

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
 * Whether the caller has given up on the connection: its hard timeout fired
 * (the watchdog marks it dead) or JS closed it.
 */
static int conn_abandoned(SybaseConnection *conn) {
  uv_mutex_lock(&conn->lock);
  int abandoned = conn->dead || conn->pending_close;
  uv_mutex_unlock(&conn->lock);
  return abandoned;
}

/*
 * db-lib's interrupt check. While a call waits on the socket, FreeTDS wakes
 * once a second and calls it — on the worker thread itself, so unlike calling
 * db-lib from the watchdog it races with nothing. Once the connection has been
 * abandoned the wait is cut short: INT_CANCEL ends it as a timeout, which
 * err_handler turns into closing the socket. Without this, a worker blocked in
 * one wait (a lock, a long waitfor) held its thread and its server session
 * until DBSETTIME, long after its hard timeout.
 */
static int interrupt_check(void *dbproc) {
  SybaseConnection *conn = (SybaseConnection *)dbgetuserdata((DBPROCESS *)dbproc);
  return conn != NULL && conn_abandoned(conn);
}

static int interrupt_handle(void *dbproc) {
  (void)dbproc;
  return INT_CANCEL;
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
  // After dbclose: db-lib holds pointers into the bound buffers until then.
  // Closing the connection in the middle of a copy is how a copy is aborted —
  // the server rolls back the batch it never saw the end of.
  bulk_state_free(conn->bulk);
  conn->bulk = NULL;
  uv_mutex_destroy(&conn->lock);
  free(conn);
}

/**
 * Per Node environment (the main thread, each worker thread). Held by the
 * environment and by each connection handle's finalizer, which may run as the
 * environment is torn down — in an order N-API does not promise — so it is
 * freed by whichever lets go of it last. Only the environment's own thread
 * touches it.
 */
typedef struct {
  int closing;  // the environment is being torn down
  int refs;
} EnvState;

static void env_state_unref(EnvState *state) {
  if (--state->refs == 0) {
    free(state);
  }
}

static void env_cleanup(void *arg) {
  ((EnvState *)arg)->closing = 1;
}

static void env_state_free(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  env_state_unref((EnvState *)data);
}

/** The state of `env`, or NULL. Not for finalizers (see conn_handle_finalize). */
static EnvState *env_state(napi_env env) {
  EnvState *state = NULL;
  if (env == NULL || napi_get_instance_data(env, (void **)&state) != napi_ok) {
    return NULL;
  }
  return state;
}

typedef struct {
  napi_async_work work;
  SybaseConnection *conn;
} DestroyWork;

static void destroy_execute(napi_env env, void *data) {
  (void)env;
  destroy_connection(((DestroyWork *)data)->conn);
  ((DestroyWork *)data)->conn = NULL;
}

static void destroy_complete(napi_env env, napi_status status, void *data) {
  (void)status;
  DestroyWork *work = (DestroyWork *)data;
  if (work->conn) {
    destroy_connection(work->conn);  // never ran (cancelled)
  }
  napi_delete_async_work(env, work->work);
  free(work);
}

/**
 * Close a connection now, or — if a query is still running on it — mark it
 * so the last worker to finish frees it (see conn_release).
 *
 * The close itself runs on the thread pool: dbclose() sends a logout and waits
 * for its answer (up to 5 s on an unresponsive network), which must not hold
 * up the JS thread. Nothing can reach the connection by then — pending_close
 * refuses every later call. It is Node's own async work, which Node waits for
 * before tearing an environment down (a worker thread that exits right after
 * a close). Only as the environment is torn down (`env` NULL or closing, as
 * for a handle finalized then) does it run here.
 */
static void close_connection(SybaseConnection *conn, napi_env env, const EnvState *state) {
  uv_mutex_lock(&conn->lock);
  int can_destroy_now = (conn->in_flight == 0);
  int already_pending = conn->pending_close;
  conn->pending_close = 1;
  conn->dead = 1;  // reject any subsequent acquire
  uv_mutex_unlock(&conn->lock);

  if (!can_destroy_now || already_pending) {
    return;  // the worker holding in_flight frees it in conn_release
  }
  int open = env != NULL && state != NULL && !state->closing;
  DestroyWork *work = open ? (DestroyWork *)calloc(1, sizeof(DestroyWork)) : NULL;
  if (work) {
    napi_value name;
    work->conn = conn;
    if (napi_create_string_utf8(env, "sybase_close", NAPI_AUTO_LENGTH, &name) == napi_ok &&
        napi_create_async_work(env, NULL, name, destroy_execute, destroy_complete, work,
                               &work->work) == napi_ok) {
      if (napi_queue_async_work(env, work->work) == napi_ok) {
        return;
      }
      napi_delete_async_work(env, work->work);
    }
    free(work);
  }
  destroy_connection(conn);
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
  // 1 while a call (query, bulkBegin, bulkSend) is queued or running. A
  // DBPROCESS takes one call at a time; the JS layer queues them, and this
  // refuses a second one from anything that does not (the exported `native`).
  int busy;
} ConnHandle;

/**
 * A call's hold on its handle: marks it busy, and references it so that the
 * handle — where `busy` is cleared — outlives the call even if JS drops it.
 */
typedef struct {
  ConnHandle *handle;
  napi_ref ref;
} HandleClaim;

/**
 * Reject `deferred` when the error meant for it could not be built: with the
 * pending JS exception if there is one (typically out of memory), else a plain
 * Error — or, if even that cannot be made, `undefined`. Never with a value
 * that was not created.
 */
static void reject_fallback(napi_env env, napi_deferred deferred, const char *message) {
  napi_value err, msg;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending &&
      napi_get_and_clear_last_exception(env, &err) == napi_ok) {
    napi_reject_deferred(env, deferred, err);
    return;
  }
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg) != napi_ok ||
      napi_create_error(env, NULL, msg, &err) != napi_ok) {
    napi_get_undefined(env, &err);
  }
  napi_reject_deferred(env, deferred, err);
}

/** A promise already rejected because the handle is busy. */
static napi_value busy_rejection(napi_env env) {
  static const char message[] =
      "Another call is still running on this connection: a connection runs one call at a time";
  napi_deferred deferred;
  napi_value promise, msg, err;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) {
    napi_throw_error(env, NULL, message);
    return NULL;
  }
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg) != napi_ok ||
      napi_create_error(env, NULL, msg, &err) != napi_ok) {
    napi_get_undefined(env, &err);
  }
  napi_reject_deferred(env, deferred, err);
  return promise;
}

/** Whether a call may start on `handle` now; a closed handle may (the call then fails as closed). */
static int handle_available(const ConnHandle *handle) {
  return handle->conn == NULL || !handle->busy;
}

/**
 * Claim `handle` for a call; -1 if it cannot be referenced — the call must then
 * not start, since nothing would keep the handle alive until it settles.
 */
static int claim_handle(napi_env env, napi_value value, ConnHandle *handle, HandleClaim *claim) {
  if (napi_create_reference(env, value, 1, &claim->ref) != napi_ok) {
    claim->ref = NULL;
    return -1;
  }
  handle->busy = 1;
  claim->handle = handle;
  return 0;
}

/** Undo claim_handle. On the JS thread, when the call has settled. */
static void release_handle(napi_env env, HandleClaim *claim) {
  if (claim->handle) {
    claim->handle->busy = 0;
    claim->handle = NULL;
  }
  if (claim->ref) {
    napi_delete_reference(env, claim->ref);
    claim->ref = NULL;
  }
}

// Identifies externals created by connect(), so an arbitrary value passed as a
// handle is rejected rather than dereferenced.
static const napi_type_tag CONN_HANDLE_TAG = {0x8f1c2a7d3b4e5f60ULL, 0x91a2b3c4d5e6f708ULL};

/**
 * GC of a handle that was never closed: close the connection it still owns —
 * on the thread pool, as close() does, unless the environment is being torn
 * down.
 */
static void conn_handle_finalize(napi_env env, void *data, void *hint) {
  EnvState *state = (EnvState *)hint;  // this handle's reference (see connect_complete)
  ConnHandle *handle = (ConnHandle *)data;
  if (handle->conn) {
    close_connection(handle->conn, env, state);
    handle->conn = NULL;
  }
  free(handle);
  env_state_unref(state);
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
    conn->last_dberr = dberr;

    if (dberr == SYBETIME) {
      conn->timed_out = 1;
    }

    if (DBDEAD(dbproc)) {
      conn_mark_dead(conn);
    }
  }

  // For the per-connection DBSETTIME firing, return INT_TIMEOUT so db-lib
  // sends a cancel and does not loop. For all other fatal errors, INT_CANCEL.
  // A wait on an abandoned connection (see conn_abandoned) also ends as a
  // timeout: INT_CANCEL then closes the socket, so the worker returns at once
  // instead of waiting for the server to answer a cancel.
  if (dberr == SYBETIME) {
    return conn && conn_abandoned(conn) ? INT_CANCEL : INT_TIMEOUT;
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
  conn->last_dberr = 0;
}

/**
 * Set the cooperative timeout of this connection alone.
 *
 * dbsetopt(DBSETTIME) sets the timeout of this DBPROCESS's own socket — unlike
 * the process-wide dbsettime(), which would reach every connection. A DBPROCESS
 * runs one call at a time, so a per-call value set before the call and restored
 * after it (see restore_query_timeout) is seen by that call only.
 */
static int set_query_timeout(SybaseConnection *conn, int seconds) {
  char value[16];
  snprintf(value, sizeof(value), "%d", seconds);
  // db-lib may fail (out of memory) without a word: the timeout is then not set.
  return dbsetopt(conn->dbproc, DBSETTIME, value, 0) == FAIL ? -1 : 0;
}

/**
 * Put back the connection's own timeout after a call that overrode it. Skipped
 * on a dead connection, which db-lib would report as one more error. -1 if it
 * could not be: the connection keeps another call's timeout, and must not be
 * used again (the caller marks it so).
 */
static int restore_query_timeout(SybaseConnection *conn, int overridden) {
  if (overridden && !DBDEAD(conn->dbproc)) {
    return set_query_timeout(conn, conn->timeout_seconds);
  }
  return 0;
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

  // unichar/univarchar arrive as UTF-16 and FreeTDS converts them to this. Set
  // explicitly, or FreeTDS takes it from the process locale — which is "C" in
  // Lambda, where a non-ASCII unichar value then comes back as '?'.
  // TDS 5.0 (Sybase ASE native). A larger TDS packet, so big result sets are
  // not shipped 512 bytes at a time (the server may cap it).
  // Each setting must take: a login sent without one (a setter may fail, out of
  // memory, without a word) would be another login than the one asked for.
  const char *unset = DBSETLUSER(w->conn->login, w->username) == FAIL ? "user name"
                      : DBSETLPWD(w->conn->login, w->password) == FAIL ? "password"
                      : DBSETLAPP(w->conn->login, "drizzle-sybase") == FAIL ? "application name"
                      : DBSETLCHARSET(w->conn->login, "UTF-8") == FAIL ? "character set"
                      : DBSETLVERSION(w->conn->login, DBVERSION_100) == FAIL ? "TDS version"
                      : w->packet_size > 0 && DBSETLPACKET(w->conn->login, w->packet_size) == FAIL
                          ? "packet size"
                          : NULL;
  if (unset) {
    snprintf(w->error, sizeof(w->error), "Could not set the login's %s", unset);
    w->success = 0;
    dbloginfree(w->conn->login);
    uv_mutex_destroy(&w->conn->lock);
    free(w->conn);
    w->conn = NULL;
    return;
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
  dbsetinterrupt(w->conn->dbproc, interrupt_check, interrupt_handle);

  // Per-connection query timeout. Replaces the legacy process-global
  // dbsettime().
  if (w->timeout_seconds > 0 && set_query_timeout(w->conn, w->timeout_seconds) != 0) {
    snprintf(w->error, sizeof(w->error), "Could not set the connection's query timeout");
    dbclose(w->conn->dbproc);
    dbloginfree(w->conn->login);
    uv_mutex_destroy(&w->conn->lock);
    free(w->conn);
    w->conn = NULL;
    w->success = 0;
    return;
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
      close_connection(w->conn, env, env_state(env));
    }
    reject_fallback(env, w->deferred, w->error);
  } else {
    napi_value result;
    ConnHandle *handle = (ConnHandle *)malloc(sizeof(ConnHandle));
    if (handle == NULL ||
        napi_create_external(env, handle, NULL, NULL, &result) != napi_ok ||
        // Untagged, the handle would be refused by every call.
        napi_type_tag_object(env, result, &CONN_HANDLE_TAG) != napi_ok) {
      // No handle for JS to close it through: close it here. (The external, if
      // made, has no finalizer and does not own the box.)
      free(handle);
      close_connection(w->conn, env, env_state(env));
      reject_fallback(env, w->deferred, "Could not create a connection handle");
    } else if (env_state(env) == NULL ||
               napi_add_finalizer(env, result, handle, conn_handle_finalize, env_state(env), NULL) !=
                   napi_ok) {
      free(handle);
      close_connection(w->conn, env, env_state(env));
      reject_fallback(env, w->deferred, "Could not create a connection handle");
    } else {
      env_state(env)->refs++;  // released by conn_handle_finalize
      handle->conn = w->conn;
      handle->busy = 0;
      napi_resolve_deferred(env, w->deferred, result);
    }
  }

  napi_delete_async_work(env, w->work);
  free(w);
}

/**
 * After a failed N-API call: NULL, with an exception pending — the one the call
 * left (a throwing getter's), or else a new Error saying `what` failed.
 */
static napi_value fail_call(napi_env env, const char *what) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok || !pending) {
    napi_throw_error(env, NULL, what);
  }
  return NULL;
}

/**
 * A string option of the connection config into `out`; -1 (with a TypeError
 * pending) if it is missing, not a string, holds a NUL, or does not fit — any
 * of which would otherwise reach db-lib as a different value.
 */
static int config_string(napi_env env, napi_value obj, const char *name, char *out, size_t size) {
  napi_value v;
  napi_valuetype type = napi_undefined;
  size_t len = 0;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok) {
    return -1;  // a throwing getter: its exception is pending
  }
  if (napi_typeof(env, v, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) {
    char message[96];
    snprintf(message, sizeof(message), "Expected `%s` to be a string", name);
    napi_throw_type_error(env, NULL, message);
    return -1;
  }
  if (len >= size) {
    char message[96];
    snprintf(message, sizeof(message), "`%s` is longer than %zu bytes", name, size - 1);
    napi_throw_type_error(env, NULL, message);
    return -1;
  }
  if (napi_get_value_string_utf8(env, v, out, size, &len) != napi_ok) {
    fail_call(env, "Could not read the connection config");
    return -1;
  }
  if (strlen(out) != len) {
    char message[96];
    snprintf(message, sizeof(message), "`%s` holds a NUL character", name);
    napi_throw_type_error(env, NULL, message);
    return -1;
  }
  return 0;
}

/** Largest integer a JS number holds exactly (2^53 - 1). */
#define MAX_SAFE_INTEGER 9007199254740991LL

/**
 * An integer option, in [min, max]; left as it is when absent and not
 * `required`. -1 (with an exception pending) otherwise — a throwing getter's
 * own, or a RangeError: a value is never truncated or wrapped into range.
 */
static int option_int64(napi_env env, napi_value obj, const char *name, int64_t min, int64_t max,
                        int required, int64_t *out) {
  napi_value v;
  napi_valuetype type = napi_undefined;
  double d = 0;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok ||
      napi_typeof(env, v, &type) != napi_ok) {
    return -1;
  }
  if (type == napi_undefined && !required) {
    return 0;
  }
  // NaN fails the range test (every comparison with it is false).
  if (type != napi_number || napi_get_value_double(env, v, &d) != napi_ok ||
      !(d >= (double)min && d <= (double)max) || d != floor(d)) {
    char message[160];
    snprintf(message, sizeof(message), "Expected `%s` to be an integer in [%lld, %lld]", name,
             (long long)min, (long long)max);
    napi_throw_range_error(env, NULL, message);
    return -1;
  }
  *out = (int64_t)d;
  return 0;
}

/** option_int64 for an int. */
static int config_int(napi_env env, napi_value obj, const char *name, int32_t min, int32_t max,
                      int required, int *out) {
  int64_t value = *out;
  if (option_int64(env, obj, name, min, max, required, &value) != 0) {
    return -1;
  }
  *out = (int)value;
  return 0;
}


/** A boolean option; left as it is when absent. -1 (exception pending) otherwise. */
static int option_bool(napi_env env, napi_value obj, const char *name, int *out) {
  napi_value v;
  napi_valuetype type = napi_undefined;
  bool flag = false;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok ||
      napi_typeof(env, v, &type) != napi_ok) {
    return -1;
  }
  if (type == napi_undefined) {
    return 0;
  }
  if (type != napi_boolean || napi_get_value_bool(env, v, &flag) != napi_ok) {
    char message[96];
    snprintf(message, sizeof(message), "Expected `%s` to be a boolean", name);
    napi_throw_type_error(env, NULL, message);
    return -1;
  }
  *out = flag ? 1 : 0;
  return 0;
}

// napi_value connect(config: { host, port, database, username, password, timeout?, packetSize? })
static napi_value fn_connect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok) {
    return NULL;
  }

  ConnectWork *w = (ConnectWork *)calloc(1, sizeof(ConnectWork));
  if (w == NULL) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }

  napi_valuetype vtype = napi_undefined;
  if (argc < 1 || napi_typeof(env, args[0], &vtype) != napi_ok || vtype != napi_object) {
    free(w);
    napi_throw_type_error(env, NULL, "Expected the connection config as an object");
    return NULL;
  }
  // Optional timeout (seconds), default 30s. Values <= 0 are coerced to 1
  // because dbsetlogintime() ignores zero/negative input but its prior
  // process-global value would silently leak through.
  w->timeout_seconds = 30;
  w->packet_size = DEFAULT_PACKET_SIZE;
  if (config_string(env, args[0], "host", w->host, sizeof(w->host)) != 0 ||
      config_string(env, args[0], "database", w->database, sizeof(w->database)) != 0 ||
      // The TDS 5.0 login record holds a user name of at most 30 bytes, and
      // FreeTDS cuts a longer one short — another account's name, perhaps — so
      // it is refused; db-lib takes a password of at most 128.
      config_string(env, args[0], "username", w->username, LOGIN_USER_MAX + 1) != 0 ||
      config_string(env, args[0], "password", w->password, LOGIN_PASSWORD_MAX + 1) != 0 ||
      config_int(env, args[0], "port", 1, 65535, 1, &w->port) != 0 ||
      config_int(env, args[0], "timeout", INT32_MIN, MAX_TIMEOUT_SECONDS, 0, &w->timeout_seconds) != 0 ||
      config_int(env, args[0], "packetSize", 512, 65535, 0, &w->packet_size) != 0) {
    free(w);
    return NULL;  // exception pending
  }
  if (w->timeout_seconds <= 0) {
    w->timeout_seconds = 1;
  }

  napi_value promise, work_name;
  if (napi_create_promise(env, &w->deferred, &promise) != napi_ok) {
    free(w);
    napi_throw_error(env, NULL, "Could not create the connection's promise");
    return NULL;
  }
  napi_status st = napi_create_string_utf8(env, "sybase_connect", NAPI_AUTO_LENGTH, &work_name);
  if (st == napi_ok) {
    st = napi_create_async_work(env, NULL, work_name, connect_execute, connect_complete, w,
                                &w->work);
  }
  if (st == napi_ok) {
    st = napi_queue_async_work(env, w->work);
    if (st != napi_ok) {
      napi_delete_async_work(env, w->work);
    }
  }
  if (st != napi_ok) {
    // connect_complete will never run: nothing was opened, so only settle and free.
    reject_fallback(env, w->deferred, "Failed to schedule the connection");
    free(w);
  }
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
  uint64_t queued_ns;  // uv_hrtime() when the call was queued: the deadline counts from there
  uint64_t end_ns;     // the deadline, on uv_hrtime()'s monotonic clock
  SybaseConnection *conn;
} Watchdog;

/** A finished result set, kept for allResultSets. */
typedef struct {
  ResultColumn *columns;
  int num_columns;
  int num_rows;
} ResultSet;

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
  // Cooperative timeout for this query alone, in seconds; 0 keeps the
  // connection's own (see set_query_timeout).
  int timeout_seconds;
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
  // 1 to keep every result set with columns (allResultSets), not just the
  // first. Each finished one is moved to `sets`, including — once the batch
  // has ended — the last; `columns` is then empty.
  int all_result_sets;
  ResultSet *sets;
  int num_sets;
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
  HandleClaim claim;
  // Watchdog
  Watchdog wd;
} QueryWork;

static void watchdog_thread(void *arg) {
  Watchdog *wd = (Watchdog *)arg;

  uv_mutex_lock(&wd->mutex);
  // Towards a fixed deadline: a wakeup before it (spurious, or anything else
  // but `finished`) waits again for the rest, never for a fresh full timeout.
  while (!wd->finished) {
    uint64_t now = uv_hrtime();
    if (now >= wd->end_ns) {
      wd->fired = 1;
      if (wd->conn) {
        conn_mark_dead(wd->conn);
      }
      break;
    }
    uv_cond_timedwait(&wd->cond, &wd->mutex, wd->end_ns - now);
  }
  uv_mutex_unlock(&wd->mutex);
}

/**
 * Start the watchdog of a call whose hard timeout is `deadline_ms` from when it
 * was queued (`queued_ns`; now, if unset): time spent waiting for a worker
 * counts. Returns 0 once started (or if disabled), -1 if it could not be, and
 * 1 if the deadline had already passed — then nothing is to be sent, and the
 * call ends as a hard timeout (`fired` is set; the connection marked dead).
 */
static int watchdog_start(Watchdog *wd, SybaseConnection *conn, int deadline_ms) {
  if (deadline_ms <= 0) {
    return 0; // disabled
  }
  uint64_t from = wd->queued_ns ? wd->queued_ns : uv_hrtime();
  wd->end_ns = from + (uint64_t)deadline_ms * 1000000ULL;
  if (uv_hrtime() >= wd->end_ns) {
    wd->fired = 1;
    conn_mark_dead(conn);
    return 1;
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

/**
 * Whether the watchdog has fired. Read by the worker between rows, so that a
 * query whose rows keep arriving — which the cooperative timeout, a limit on
 * each wait for the server, never interrupts — still ends at its hard timeout
 * instead of reading on after the caller has been told it failed.
 */
static int watchdog_fired(Watchdog *wd) {
  if (!wd->started) {
    return 0;
  }
  uv_mutex_lock(&wd->mutex);
  int fired = wd->fired;
  uv_mutex_unlock(&wd->mutex);
  return fired;
}

/** Rows read between checks of the watchdog: often enough, at a negligible cost. */
#define WATCHDOG_CHECK_ROWS 256

/**
 * Whether a call should stop between rows: its hard timeout fired, or the
 * caller closed the connection. Rows that keep arriving never let db-lib's
 * interrupt check run (it runs in waits), so a close must be seen here too.
 */
static int call_abandoned(Watchdog *wd, SybaseConnection *conn) {
  return watchdog_fired(wd) || conn_abandoned(conn);
}

static void watchdog_stop(Watchdog *wd) {
  if (!wd->started) {
    return;
  }
  uv_mutex_lock(&wd->mutex);
  // Past the deadline is a timeout whether or not the watchdog thread got to
  // run by then: the call must not end as if it had kept to it.
  if (!wd->fired && uv_hrtime() >= wd->end_ns) {
    wd->fired = 1;
    if (wd->conn) {
      conn_mark_dead(wd->conn);
    }
  }
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

/**
 * discard_rows, stopping when the hard timeout has fired: FAIL then too. The
 * connection is dead by then, so nothing is cancelled; it is closed.
 */
static RETCODE query_discard_rows(QueryWork *w) {
  RETCODE rc;
  long n = 0;
  while ((rc = dbnextrow(w->conn->dbproc)) != NO_MORE_ROWS) {
    if (rc == FAIL || (++n % WATCHDOG_CHECK_ROWS == 0 && call_abandoned(&w->wd, w->conn))) {
      return FAIL;
    }
  }
  return SUCCEED;
}

/** Drop whatever result the work item has collected. */
static void discard_results(QueryWork *w) {
  free_columns(w->columns, w->num_columns);
  w->columns = NULL;
  w->num_columns = 0;
  w->num_rows = 0;
  for (int i = 0; i < w->num_sets; i++) {
    free_columns(w->sets[i].columns, w->sets[i].num_columns);
  }
  free(w->sets);
  w->sets = NULL;
  w->num_sets = 0;
}

/** Move the result set just read to `sets`. Returns -1 (with `w->error` set) when out of memory. */
static int keep_result_set(QueryWork *w) {
  ResultSet *grown = (ResultSet *)realloc(w->sets, (size_t)(w->num_sets + 1) * sizeof(ResultSet));
  if (!grown) {
    snprintf(w->error, sizeof(w->error), "Memory allocation failed for result sets");
    return -1;
  }
  w->sets = grown;
  w->sets[w->num_sets++] = (ResultSet){w->columns, w->num_columns, w->num_rows};
  w->columns = NULL;
  w->num_columns = 0;
  w->num_rows = 0;
  return 0;
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
    // The file is this call's own (O_EXCL): leave nothing behind.
    int saved = errno;
    close(fd);
    unlink(path);
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
    w->conn_dead = 1;
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
    w->conn_dead = 1;
    work_release_conn(w);
    return;
  }

  // Check if connection is dead.
  if (conn_is_dead(w->conn) || DBDEAD(w->conn->dbproc)) {
    snprintf(w->error, sizeof(w->error), "Connection is dead");
    conn_mark_dead(w->conn);
    w->success = 0;
    w->conn_dead = 1;
    work_release_conn(w);
    return;
  }

  // The DBPROCESS is in the middle of a bulk copy: SQL sent now would be read
  // by the server as bulk data.
  if (w->conn->bulk) {
    snprintf(w->error, sizeof(w->error), "A bulk copy is in progress on this connection");
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
    int named = w->out_buf && w->out_tmp;
    if (named) {
      snprintf(w->out_tmp, tmp_size, "%s.%llx-%p.tmp", w->out_path,
               (unsigned long long)uv_hrtime(), (void *)w);
      w->out = open_output(w->out_tmp);
    }
    if (!w->out) {
      // The temporary's name only once it has been written into its buffer.
      snprintf(w->error, sizeof(w->error), "Could not create %s: %s",
               named ? w->out_tmp : w->out_path, named ? strerror(errno) : "out of memory");
      w->success = 0;
      w->conn_dead = conn_is_dead(w->conn);
      work_release_conn(w);
      return;
    }
  }

  // Restored at `done`, which every path from here on goes through.
  int timeout_overridden = w->timeout_seconds > 0 && w->timeout_seconds != w->conn->timeout_seconds;

  // The hard timeout depends on the watchdog: DBSETTIME bounds each wait for
  // the server, not a query whose rows keep arriving. Without one the query
  // does not start, rather than run without its deadline.
  int started = watchdog_start(&w->wd, w->conn, w->hard_timeout_ms);
  if (started != 0) {
    // Expired while queued: `done` reports the hard timeout.
    snprintf(w->error, sizeof(w->error), "Could not start the hard-timeout watchdog");
    w->success = 0;
    timeout_overridden = 0;
    goto done;
  }

  // Nothing is sent without the timeout asked for. Not overridden, there is
  // nothing to put back (the connection's own timeout is still set).
  if (timeout_overridden && set_query_timeout(w->conn, w->timeout_seconds) != 0) {
    snprintf(w->error, sizeof(w->error), "Could not set the query's timeout");
    w->success = 0;
    timeout_overridden = 0;
    goto done;
  }

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
    if (call_abandoned(&w->wd, w->conn)) {
      goto rows_failed;
    }
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
      if (query_discard_rows(w) == FAIL) {
        goto rows_failed;
      }
      continue;
    }

    // Only the first result set with columns is returned, unless every one
    // was asked for: the one read before this is then kept aside.
    if (found_resultset && !w->all_result_sets) {
      if (query_discard_rows(w) == FAIL) {
        goto rows_failed;
      }
      continue;
    }
    if (found_resultset && keep_result_set(w) != 0) {
      discard_results(w);
      dbcancel(w->conn->dbproc);
      w->success = 0;
      goto done;
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
    long rows_read = 0;
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

      if (++rows_read % WATCHDOG_CHECK_ROWS == 0 && call_abandoned(&w->wd, w->conn)) {
        goto rows_failed;
      }

      // Safety: cap rows
      if ((file_mode ? w->out_rows : w->num_rows) >= row_cap) {
        w->truncated = 1;
        // Drain remaining rows without storing
        if (query_discard_rows(w) == FAIL) {
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

  if (w->all_result_sets && found_resultset && keep_result_set(w) != 0) {
    discard_results(w);
    w->success = 0;
    goto done;
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
  // The result stream broke (typically a dead connection), or the hard
  // timeout fired and the rest is not read. No dbcancel: the connection is
  // dead either way, and is closed.
  if (w->conn->has_error) {
    snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
  } else if (conn_abandoned(w->conn)) {
    snprintf(w->error, sizeof(w->error), "Connection was closed while the query ran");
  } else {
    snprintf(w->error, sizeof(w->error), "dbnextrow() failed");
  }
  discard_results(w);
  w->success = 0;

done:
  // A connection left with this call's timeout must not be used again: the
  // result stands, but the connection is given up.
  if (restore_query_timeout(w->conn, timeout_overridden) != 0) {
    conn_mark_dead(w->conn);
  }

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
    // Decided under the lock close_connection sets pending_close under: a close
    // that lands first stops the publishing. The rename itself runs outside it:
    // a close must never wait on the file system (a hung network share would
    // hold up the JS thread with it). A close landing after the decision finds
    // the export finished — or finishing, if the rename is slow.
    uv_mutex_lock(&w->conn->lock);
    if (w->success && w->conn->pending_close) {
      snprintf(w->error, sizeof(w->error), "Connection was closed before the export finished");
      w->success = 0;
    }
    uv_mutex_unlock(&w->conn->lock);
    if (w->success && publish_output(w->out_tmp, w->out_path) != 0) {
      snprintf(w->error, sizeof(w->error), "Could not move %s to %s: %s", w->out_tmp, w->out_path,
               strerror(errno));
      w->success = 0;
    }
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
/** One result set's `columns`, `columnTypes` and (unless written to a file) `data`, set on `out`. */
static napi_status build_set(napi_env env, const ResultColumn *columns, int num_columns,
                             int num_rows, int with_data, napi_value out) {
  napi_value cols_arr, col_types_arr, data_arr;
  size_t ncols = (size_t)num_columns;
  NAPI_TRY(napi_create_array_with_length(env, ncols, &cols_arr));
  NAPI_TRY(napi_create_array_with_length(env, ncols, &col_types_arr));
  NAPI_TRY(napi_create_array_with_length(env, ncols, &data_arr));

  // Column names, Sybase type names and values, in column order
  for (int i = 0; i < num_columns; i++) {
    napi_value col_name, col_type, col_data;
    NAPI_TRY(napi_create_string_utf8(env, columns[i].name, NAPI_AUTO_LENGTH, &col_name));
    NAPI_TRY(napi_set_element(env, cols_arr, (uint32_t)i, col_name));
    NAPI_TRY(napi_create_string_utf8(env, syb_type_name(columns[i].type), NAPI_AUTO_LENGTH,
                                     &col_type));
    NAPI_TRY(napi_set_element(env, col_types_arr, (uint32_t)i, col_type));
    if (with_data) {
      NAPI_TRY(build_column(env, &columns[i], num_rows, &col_data));
      NAPI_TRY(napi_set_element(env, data_arr, (uint32_t)i, col_data));
    }
  }
  if (with_data) {
    napi_value row_count;
    NAPI_TRY(napi_create_int32(env, num_rows, &row_count));
    NAPI_TRY(napi_set_named_property(env, out, "rowCount", row_count));
    NAPI_TRY(napi_set_named_property(env, out, "data", data_arr));
  }
  NAPI_TRY(napi_set_named_property(env, out, "columns", cols_arr));
  return napi_set_named_property(env, out, "columnTypes", col_types_arr);
}

/**
 * `{ columns, columnTypes, data, rowCount, affectedRows }`; for a result
 * streamed to a file, `{ columns, columnTypes, rowCount, affectedRows, bytes }`.
 * With allResultSets, also `resultSets: [{ columns, columnTypes, data, rowCount }]`,
 * the top level then describing the first of them.
 */
static napi_status build_result(napi_env env, const QueryWork *w, napi_value *out) {
  napi_value affected;
  NAPI_TRY(napi_create_object(env, out));
  if (w->all_result_sets) {
    napi_value sets, first = NULL;
    NAPI_TRY(napi_create_array_with_length(env, (size_t)w->num_sets, &sets));
    for (int i = 0; i < w->num_sets; i++) {
      napi_value set;
      NAPI_TRY(napi_create_object(env, &set));
      NAPI_TRY(build_set(env, w->sets[i].columns, w->sets[i].num_columns, w->sets[i].num_rows, 1,
                         set));
      NAPI_TRY(napi_set_element(env, sets, (uint32_t)i, set));
      if (i == 0) {
        first = set;
      }
    }
    if (first) {
      // The top level is the first set: the same arrays, not a second copy.
      static const char *const keys[] = {"columns", "columnTypes", "data", "rowCount"};
      for (size_t k = 0; k < sizeof(keys) / sizeof(keys[0]); k++) {
        napi_value value;
        NAPI_TRY(napi_get_named_property(env, first, keys[k], &value));
        NAPI_TRY(napi_set_named_property(env, *out, keys[k], value));
      }
    } else {
      NAPI_TRY(build_set(env, NULL, 0, 0, 1, *out));
    }
    NAPI_TRY(napi_set_named_property(env, *out, "resultSets", sets));
  } else {
    NAPI_TRY(build_set(env, w->columns, w->num_columns, w->num_rows, !w->out_path, *out));
  }
  if (w->out_path) {
    // Past int32 for a large file; exact in a double far beyond any row count.
    napi_value row_count, bytes;
    NAPI_TRY(napi_create_double(env, (double)w->out_rows, &row_count));
    NAPI_TRY(napi_create_double(env, (double)w->out_bytes, &bytes));
    NAPI_TRY(napi_set_named_property(env, *out, "bytes", bytes));
    NAPI_TRY(napi_set_named_property(env, *out, "rowCount", row_count));
  }
  NAPI_TRY(napi_create_int32(env, w->affected_rows, &affected));
  return napi_set_named_property(env, *out, "affectedRows", affected);
}

/** The error a failed query rejects with: its message and what became of the connection. */
static napi_status query_error(napi_env env, const QueryWork *w, napi_value *error) {
  napi_value msg, flag;
  NAPI_TRY(napi_create_string_utf8(env, w->error, NAPI_AUTO_LENGTH, &msg));
  NAPI_TRY(napi_create_error(env, NULL, msg, error));
  NAPI_TRY(napi_get_boolean(env, true, &flag));
  if (w->conn_dead) {
    NAPI_TRY(napi_set_named_property(env, *error, "connectionDead", flag));
  }
  if (w->conn_timed_out) {
    NAPI_TRY(napi_set_named_property(env, *error, "timedOut", flag));
  }
  if (w->wd.fired) {
    NAPI_TRY(napi_set_named_property(env, *error, "hardTimeout", flag));
  }
  return napi_ok;
}

static void query_complete(napi_env env, napi_status status, void *data) {
  QueryWork *w = (QueryWork *)data;

  if (status == napi_cancelled || !w->success) {
    napi_value error_obj;
    if (query_error(env, w, &error_obj) == napi_ok) {
      napi_reject_deferred(env, w->deferred, error_obj);
    } else {
      reject_fallback(env, w->deferred, w->error);
    }
  } else {
    napi_value result;
    if (build_result(env, w, &result) == napi_ok) {
      napi_resolve_deferred(env, w->deferred, result);
    } else {
      // Typically V8 running out of memory for a very large result.
      reject_fallback(env, w->deferred, "Could not hand the query result to JavaScript");
    }
  }

  // Cleanup — always runs regardless of success/failure
  // A cancelled work item never ran query_execute, so its slot is still held.
  work_release_conn(w);
  release_handle(env, &w->claim);
  discard_results(w);
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
/**
 * db-lib takes the SQL as a C string: a NUL would end it there, and the server
 * would run only what comes before.
 */
static const char sql_nul_message[] =
    "The SQL contains a NUL character, which would cut it short: only what precedes it would run";

static char *sql_bytes(napi_env env, napi_value value, int latin1) {
  size_t len = 0;
  if (!latin1) {
    if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) {
      return (char *)fail_call(env, "Could not read the SQL");
    }
    char *out = (char *)malloc(len + 1);
    if (!out) {
      napi_throw_error(env, NULL, "Out of memory");
      return NULL;
    }
    if (napi_get_value_string_utf8(env, value, out, len + 1, &len) != napi_ok) {
      free(out);
      return (char *)fail_call(env, "Could not read the SQL");
    }
    if (strlen(out) != len) {
      free(out);
      napi_throw_type_error(env, NULL, sql_nul_message);
      return NULL;
    }
    return out;
  }
  if (napi_get_value_string_utf16(env, value, NULL, 0, &len) != napi_ok) {
    return (char *)fail_call(env, "Could not read the SQL");
  }
  char16_t *units = (char16_t *)malloc((len + 1) * sizeof(char16_t));
  char *out = units ? (char *)malloc(len + 1) : NULL;
  if (!out) {
    free(units);
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  if (napi_get_value_string_utf16(env, value, units, len + 1, &len) != napi_ok) {
    free(units);
    free(out);
    return (char *)fail_call(env, "Could not read the SQL");
  }
  for (size_t i = 0; i < len; i++) {
    if (units[i] == 0) {
      free(units);
      free(out);
      napi_throw_type_error(env, NULL, sql_nul_message);
      return NULL;
    }
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
// options.allResultSets: return every result set with columns as `resultSets`,
//   not only the first (the top level still describes the first).
// options.timeoutSeconds: the cooperative timeout of this query alone.
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
  if (!handle_available(handle)) {
    return busy_rejection(env);
  }

  napi_valuetype sql_type = napi_undefined;
  if (argc < 2 || napi_typeof(env, args[1], &sql_type) != napi_ok || sql_type != napi_string) {
    napi_throw_type_error(env, NULL, "Expected the SQL as a string");
    return NULL;
  }

  QueryWork *w = (QueryWork *)calloc(1, sizeof(QueryWork));
  if (w == NULL) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  w->max_rows = DEFAULT_MAX_ROWS;
  int hard_timeout_given = 0;

  // The options first: reading them may run JavaScript (a getter), which may
  // close the handle or start another call on it. Its connection is looked at
  // only after, once nothing else can run.
  // Each option is checked, never truncated or ignored: a getter that throws
  // leaves its exception pending; a value out of range is refused.
  if (argc >= 3) {
    napi_valuetype vtype = napi_undefined;
    if (napi_typeof(env, args[2], &vtype) != napi_ok) {
      free(w);
      return fail_call(env, "Could not read the query options");
    }
    if (vtype == napi_object) {
      napi_value v;
      napi_valuetype ptype = napi_undefined;
      int max_rows = 0;
      int path_ok = 1;
      if (config_int(env, args[2], "timeoutSeconds", 1, MAX_TIMEOUT_SECONDS, 0,
                     &w->timeout_seconds) != 0 ||
          config_int(env, args[2], "maxRows", 1, INT32_MAX, 0, &max_rows) != 0 ||
          config_int(env, args[2], "hardTimeoutMs", 1, INT32_MAX, 0, &w->hard_timeout_ms) != 0 ||
          option_bool(env, args[2], "wallClockDateTimes", &w->wall_clock_datetimes) != 0 ||
          option_bool(env, args[2], "allResultSets", &w->all_result_sets) != 0 ||
          napi_get_named_property(env, args[2], "outputPath", &v) != napi_ok ||
          napi_typeof(env, v, &ptype) != napi_ok) {
        free(w);
        return fail_call(env, "Could not read the query options");
      }
      if (max_rows > 0) {
        w->max_rows = max_rows;
        w->max_rows_explicit = 1;
      }
      hard_timeout_given = w->hard_timeout_ms > 0;
      if (ptype == napi_string) {
        size_t path_len = 0;
        path_ok = napi_get_value_string_utf8(env, v, NULL, 0, &path_len) == napi_ok;
        w->out_path = path_ok ? (char *)malloc(path_len + 1) : NULL;
        if (path_ok && w->out_path == NULL) {
          free(w);
          napi_throw_error(env, NULL, "Out of memory");
          return NULL;
        }
        path_ok = path_ok &&
                  napi_get_value_string_utf8(env, v, w->out_path, path_len + 1, &path_len) == napi_ok &&
                  // A NUL would cut the path short in C, and write somewhere else.
                  path_len > 0 && strlen(w->out_path) == path_len;
        // Datetimes go to the file as their canonical text; a file holds one result set.
        w->wall_clock_datetimes = 0;
        w->all_result_sets = 0;
      } else if (ptype != napi_undefined) {
        path_ok = 0;
      }
      if (!path_ok) {
        free(w->out_path);
        free(w);
        napi_throw_type_error(env, NULL, "Expected outputPath as a non-empty path without NUL");
        return NULL;
      }
    } else if (vtype != napi_undefined) {
      free(w);
      napi_throw_type_error(env, NULL, "Expected the query options as an object");
      return NULL;
    }
  }

  // Checked again now that no JavaScript can run before the call is queued.
  if (!handle_available(handle)) {
    free(w->out_path);
    free(w);
    return busy_rejection(env);
  }
  // A closed handle has no connection: the query is rejected as on a closed
  // connection (holds_conn stays 0 below).
  w->conn = handle->conn;

  // The SQL goes to the server in its own character set (see SybaseConnection.latin1).
  w->sql = sql_bytes(env, args[1], w->conn != NULL && w->conn->latin1);
  if (w->sql == NULL) {
    free(w->out_path);
    free(w);
    return NULL;  // error pending
  }

  // Hard timeout: 2x the cooperative timeout of this call, with a 30s floor so
  // very small timeouts don't translate to absurdly tight watchdog deadlines.
  // In 64 bits, and capped: a long timeout must not wrap around to a short one.
  if (!hard_timeout_given) {
    int64_t base_timeout_s = w->timeout_seconds > 0 ? w->timeout_seconds
                             : (w->conn && w->conn->timeout_seconds > 0) ? w->conn->timeout_seconds
                                                                          : 30;
    int64_t ms = base_timeout_s * 2000;
    w->hard_timeout_ms = ms < 30000 ? 30000 : ms > INT32_MAX ? INT32_MAX : (int)ms;
  }

  // The hard timeout counts from now, not from when a worker picks it up.
  w->wd.queued_ns = uv_hrtime();
  if (claim_handle(env, args[0], handle, &w->claim) != 0) {
    free(w->sql);
    free(w->out_path);
    free(w);
    napi_throw_error(env, NULL, "Could not reference the connection handle");
    return NULL;
  }

  // Pin the connection now, on the JS thread, rather than when a worker picks
  // the job up: fn_close only defers the free while in_flight > 0, and the
  // job may sit in the libuv queue behind other queries for a long time. And
  // before the promise is made: making one runs promise hooks, JavaScript that
  // may close this handle.
  w->holds_conn = (w->conn != NULL && conn_acquire(w->conn) == 0);

  napi_value promise, work_name;
  if (napi_create_promise(env, &w->deferred, &promise) != napi_ok) {
    work_release_conn(w);
    release_handle(env, &w->claim);
    free(w->sql);
    free(w->out_path);
    free(w);
    napi_throw_error(env, NULL, "Could not create the query's promise");
    return NULL;
  }

  napi_status st = napi_create_string_utf8(env, "sybase_query", NAPI_AUTO_LENGTH, &work_name);
  if (st == napi_ok) {
    st = napi_create_async_work(env, NULL, work_name, query_execute, query_complete, w, &w->work);
  }
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
    release_handle(env, &w->claim);
    reject_fallback(env, w->deferred, "Failed to schedule query");
    free(w->sql);
    free(w->out_path);
    free(w);
  }

  return promise;
}

// ---------------------------------------------------------------------------
// Bulk copy in
//
// db-lib's bulk copy API (bcp_init, bcp_bind, bcp_sendrow, bcp_batch,
// bcp_done) over TDS 5.0. One copy spans several calls from JS — bulkBegin,
// then bulkSend once per chunk of rows — and in between the DBPROCESS stays in
// the middle of the copy (conn->bulk) and takes no other command. JS holds the
// connection for the whole copy.
//
// What FreeTDS does and does not do here shapes this code:
//   - It cuts a value longer than its column to the column's size, silently.
//     So every value is checked here first: nothing is truncated, an over-long
//     value rejects its row.
//   - It does not convert text: on TDS 5.0 a row goes to the server as the
//     server's own row image. Text is encoded here — to Latin-1 for an iso_1
//     server — and a character the server's character set cannot hold rejects
//     its row instead of becoming '?'.
//   - It cannot abandon a batch: dbcancel() in the middle of bulk data is not
//     implemented ("TODO handle cancellation sending data"). A copy is
//     abandoned by closing the connection, and the server rolls back the batch
//     whose end it never received. A failed copy therefore marks its
//     connection dead.
//   - Its text conversions round (money, numeric) where a copy must fail
//     instead, so values are converted to the column's binary form here, by
//     exact parsers, and bound in that form.
//   - It substitutes the column default for a NULL, as the bcp utility does,
//     unless the KEEP_NULLS hint is given (bcp's --ignoredefaults).
// ---------------------------------------------------------------------------

/** How a column's values are converted; see bulk_classify. */
typedef enum {
  BULK_INT,            // tinyint, smallint, int, bigint: bound as a bigint
  BULK_BIT,            // bit
  BULK_FLOAT,          // float, real: bound as a float
  BULK_MONEY,          // money, smallmoney: bound as money
  BULK_NUMERIC,        // numeric, decimal
  BULK_DATETIME,       // datetime
  BULK_SMALLDATETIME,  // smalldatetime
  BULK_TEXT,           // char, varchar (and nchar, nvarchar)
  BULK_BINARY,         // binary, varbinary
  BULK_UNSUPPORTED,
} BulkKind;

typedef struct {
  char *name;      // UTF-8
  int type;        // column_type()
  int usertype;
  BulkKind kind;
  int max_length;  // bytes
  int precision;
  int scale;
  int nullable;
  int identity;
  int64_t min;     // BULK_INT range
  int64_t max;
  BYTE *buf;       // the value of the row being sent, when the column is bound
} BulkColumn;

/** One field of a row: UTF-8 bytes (TSV input) or UTF-16 units (value rows). */
typedef struct {
  const unsigned char *bytes;
  const uint16_t *units;
  size_t length;  // in bytes or units
} BulkField;

typedef struct BulkState {
  BulkColumn *columns;  // every column of the table, in table order
  int num_columns;
  int *bound;           // indexes into `columns`, in the order rows give their values
  int num_bound;
  int started;          // 1 once bcp_sendrow has opened the copy on the server
  int reopen_failed;    // a committed batch's copy could not be opened again
  char reopen_error[512];
  int timeout_overridden;
  char *table;
  int identity_insert;  // 1 while `set identity_insert <table> on` is in effect
  unsigned char *text;  // scratch for a text value in the server's encoding
  size_t text_cap;
  BulkField *fields;        // the row being sent, one per bound column
  unsigned char *is_null;   // and whether each is NULL
} BulkState;

static void bulk_state_free(struct BulkState *state) {
  if (!state) {
    return;
  }
  for (int i = 0; i < state->num_columns; i++) {
    free(state->columns[i].name);
    free(state->columns[i].buf);
  }
  free(state->columns);
  free(state->bound);
  free(state->table);
  free(state->text);
  free(state->fields);
  free(state->is_null);
  free(state);
}

/** The ASE usertype of `timestamp` columns, which the server fills itself. */
#define USERTYPE_TIMESTAMP 80

/**
 * How values of a column are converted. Columns of any other type can stay out
 * of a copy (they then get NULL or their default) but cannot be loaded.
 */
static void bulk_classify(BulkColumn *col) {
  col->kind = BULK_UNSUPPORTED;
  if (col->usertype == 34 || col->usertype == 35 || col->usertype == USERTYPE_TIMESTAMP) {
    return;  // unichar / univarchar (UTF-16 on the wire), timestamp
  }
  switch (col->type) {
    case SYBINT1:
      col->kind = BULK_INT, col->min = 0, col->max = 255;
      break;
    case SYBINT2:
      col->kind = BULK_INT, col->min = INT16_MIN, col->max = INT16_MAX;
      break;
    case SYBINT4:
      col->kind = BULK_INT, col->min = INT32_MIN, col->max = INT32_MAX;
      break;
    case SYBINT8:
      col->kind = BULK_INT, col->min = INT64_MIN, col->max = INT64_MAX;
      break;
    case SYBBIT:
      col->kind = BULK_BIT;
      break;
    case SYBFLT8:
    case SYBREAL:
      col->kind = BULK_FLOAT;
      break;
    case SYBMONEY:
      col->kind = BULK_MONEY, col->min = INT64_MIN, col->max = INT64_MAX;
      break;
    case SYBMONEY4:
      col->kind = BULK_MONEY, col->min = INT32_MIN, col->max = INT32_MAX;
      break;
    case SYBNUMERIC:
    case SYBDECIMAL:
      if (col->precision >= 1 && col->precision <= 38 && col->scale <= col->precision) {
        col->kind = BULK_NUMERIC;
      }
      break;
    case SYBDATETIME:
      col->kind = BULK_DATETIME;
      break;
    case SYBDATETIME4:
      col->kind = BULK_SMALLDATETIME;
      break;
    case SYBCHAR:
    case SYBVARCHAR:
      col->kind = BULK_TEXT;
      break;
    case SYBBINARY:
    case SYBVARBINARY:
      col->kind = BULK_BINARY;
      break;
    default:
      break;
  }
}

/** Bytes of the bound value of each kind, and the host type it is bound as. */
static void bulk_binding(const BulkColumn *col, int *size, int *host_type, int *varlen) {
  switch (col->kind) {
    case BULK_INT:
      *size = sizeof(DBBIGINT), *host_type = SYBINT8, *varlen = -1;
      return;
    case BULK_BIT:
      *size = sizeof(DBBIT), *host_type = SYBBIT, *varlen = -1;
      return;
    case BULK_FLOAT:
      *size = sizeof(DBFLT8), *host_type = SYBFLT8, *varlen = -1;
      return;
    case BULK_MONEY:
      *size = sizeof(DBMONEY), *host_type = SYBMONEY, *varlen = -1;
      return;
    case BULK_NUMERIC:
      *size = sizeof(DBNUMERIC), *host_type = SYBNUMERIC, *varlen = (int)sizeof(DBNUMERIC);
      return;
    case BULK_DATETIME:
      *size = sizeof(DBDATETIME), *host_type = SYBDATETIME, *varlen = -1;
      return;
    case BULK_SMALLDATETIME:
      *size = sizeof(DBDATETIME4), *host_type = SYBDATETIME4, *varlen = -1;
      return;
    case BULK_TEXT:
      *size = col->max_length > 0 ? col->max_length : 1, *host_type = SYBCHAR, *varlen = *size;
      return;
    default:  // BULK_BINARY
      *size = col->max_length > 0 ? col->max_length : 1, *host_type = SYBBINARY, *varlen = *size;
      return;
  }
}

// --- Value parsing -----------------------------------------------------------
//
// Strict: a value either converts exactly or rejects its row with a reason.
// Nothing is rounded except what the column type itself cannot hold — a
// datetime keeps 1/300 s, a smalldatetime whole minutes — and that rounding is
// the server's own, so a copied value equals the same literal inserted by SQL.

/** Longest non-text value accepted, in characters (a numeric(38) with sign, point and zeros). */
#define BULK_TOKEN_MAX 128

/** The field as NUL-terminated ASCII in `out`; -1 if it is longer or not ASCII. */
static int bulk_ascii(const BulkField *f, char *out) {
  if (f->length >= BULK_TOKEN_MAX) {
    return -1;
  }
  for (size_t i = 0; i < f->length; i++) {
    unsigned c = f->units ? f->units[i] : f->bytes[i];
    if (c == 0 || c >= 0x80) {
      return -1;
    }
    out[i] = (char)c;
  }
  out[f->length] = '\0';
  return 0;
}

static int is_digit(char c) {
  return c >= '0' && c <= '9';
}

/** `[+-]?digits` in [min, max]. */
static int parse_bulk_int(const char *s, int64_t min, int64_t max, int64_t *out) {
  int negative = *s == '-';
  if (*s == '-' || *s == '+') {
    s++;
  }
  if (!is_digit(*s)) {
    return -1;
  }
  uint64_t magnitude = 0;
  for (; is_digit(*s); s++) {
    unsigned d = (unsigned)(*s - '0');
    if (magnitude > (UINT64_MAX - d) / 10) {
      return -1;
    }
    magnitude = magnitude * 10 + d;
  }
  if (*s != '\0') {
    return -1;
  }
  if (negative) {
    if (magnitude > (uint64_t)INT64_MAX + 1) {
      return -1;
    }
    int64_t v = magnitude == (uint64_t)INT64_MAX + 1 ? INT64_MIN : -(int64_t)magnitude;
    if (v < min) {
      return -1;
    }
    *out = v;
    return 0;
  }
  if (magnitude > (uint64_t)max) {
    return -1;
  }
  *out = (int64_t)magnitude;
  return 0;
}

/**
 * A decimal literal `[+-]?(digits[.digits?] | .digits)`, without leading zeros
 * in the integer part or trailing zeros in the fraction (they change nothing,
 * so "1.50000" fits a scale of 1). `digits` holds the integer digits, then the
 * fraction digits.
 */
typedef struct {
  int negative;
  char digits[BULK_TOKEN_MAX];
  int int_len;
  int frac_len;
} BulkDecimal;

static int parse_bulk_decimal(const char *s, BulkDecimal *d) {
  d->negative = *s == '-';
  if (*s == '-' || *s == '+') {
    s++;
  }
  const char *int_start = s;
  while (is_digit(*s)) {
    s++;
  }
  const char *int_end = s;
  const char *frac_start = s, *frac_end = s;
  if (*s == '.') {
    frac_start = ++s;
    while (is_digit(*s)) {
      s++;
    }
    frac_end = s;
  }
  if (*s != '\0' || (int_end == int_start && frac_end == frac_start)) {
    return -1;
  }
  while (int_start < int_end && *int_start == '0') {
    int_start++;
  }
  while (frac_end > frac_start && frac_end[-1] == '0') {
    frac_end--;
  }
  d->int_len = (int)(int_end - int_start);
  d->frac_len = (int)(frac_end - frac_start);
  memcpy(d->digits, int_start, (size_t)d->int_len);
  memcpy(d->digits + d->int_len, frac_start, (size_t)d->frac_len);
  if (d->int_len + d->frac_len == 0) {
    d->negative = 0;  // -0
  }
  return 0;
}

/** money / smallmoney: exactly, in ten-thousandths. */
static int parse_bulk_money(const char *s, const BulkColumn *col, DBMONEY *out, const char **why) {
  BulkDecimal d;
  if (parse_bulk_decimal(s, &d) != 0) {
    *why = "is not a decimal number";
    return -1;
  }
  if (d.frac_len > 4) {
    *why = "has more than 4 decimal places (money keeps 4; nothing is rounded)";
    return -1;
  }
  uint64_t units = 0;
  int ok = d.int_len <= 15;
  for (int i = 0; ok && i < d.int_len + 4; i++) {
    units = units * 10 + (uint64_t)(i < d.int_len + d.frac_len ? d.digits[i] - '0' : 0);
  }
  uint64_t limit = d.negative ? (uint64_t)(-(col->min + 1)) + 1 : (uint64_t)col->max;
  if (!ok || units > limit) {
    *why = "is out of range for the column";
    return -1;
  }
  int64_t v = d.negative ? (int64_t)(0 - units) : (int64_t)units;
  out->mnyhigh = (DBINT)(int32_t)((uint64_t)v >> 32);
  out->mnylow = (DBUINT)(uint32_t)(uint64_t)v;
  return 0;
}

/** numeric(p, s) / decimal(p, s): exactly, or not at all. */
static int parse_bulk_numeric(const char *s, const BulkColumn *col, DBNUMERIC *out,
                              const char **why) {
  BulkDecimal d;
  if (parse_bulk_decimal(s, &d) != 0) {
    *why = "is not a decimal number";
    return -1;
  }
  if (d.frac_len > col->scale) {
    *why = "has more decimal places than the column's scale (nothing is rounded)";
    return -1;
  }
  if (d.int_len > col->precision - col->scale) {
    *why = "is out of range for the column's precision";
    return -1;
  }
  // The magnitude, digits * 10^(scale - frac_len), as 32-bit limbs (most
  // significant first): 38 digits need 127 bits.
  uint32_t limbs[5] = {0};
  int total = d.int_len + col->scale;
  for (int i = 0; i < total; i++) {
    uint64_t carry = (uint64_t)(i < d.int_len + d.frac_len ? d.digits[i] - '0' : 0);
    for (int k = 4; k >= 0; k--) {
      uint64_t v = (uint64_t)limbs[k] * 10 + carry;
      limbs[k] = (uint32_t)v;
      carry = v >> 32;
    }
  }
  memset(out, 0, sizeof(*out));
  out->precision = (BYTE)col->precision;
  out->scale = (BYTE)col->scale;
  int magnitude_bytes = NUMERIC_BYTES[col->precision] - 1;
  for (int b = 0; b < magnitude_bytes; b++) {
    int from_low = magnitude_bytes - 1 - b;
    out->array[1 + b] = (BYTE)(limbs[4 - from_low / 4] >> (8 * (from_low % 4)));
  }
  out->array[0] = (BYTE)(d.negative ? 1 : 0);
  return 0;
}

/** `n` digits from `s` as a number, or -1. */
static int read_digits(const char *s, int n) {
  int v = 0;
  for (int i = 0; i < n; i++) {
    if (!is_digit(s[i])) {
      return -1;
    }
    v = v * 10 + (s[i] - '0');
  }
  return v;
}

static int days_in_month(int year, int month) {
  static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  int leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  return month == 2 && leap ? 29 : days[month - 1];
}

/**
 * A wall clock `YYYY-MM-DD[( |T)HH:MM[:SS[.f{1,3}]]]`, as days since 1900-01-01
 * and milliseconds into the day. No zone, no shifting: it is stored as written.
 */
static int parse_bulk_wall_clock(const char *s, int64_t *days, int64_t *ms) {
  size_t n = strlen(s);
  int year = read_digits(s, 4), month = -1, day = -1, hour = 0, minute = 0, second = 0, milli = 0;
  if (n < 10 || year < 0 || s[4] != '-' || s[7] != '-') {
    return -1;
  }
  month = read_digits(s + 5, 2);
  day = read_digits(s + 8, 2);
  const char *t = s + 10;
  if (*t != '\0') {
    if ((*t != ' ' && *t != 'T') || strlen(t) < 6 || t[3] != ':') {
      return -1;
    }
    hour = read_digits(t + 1, 2);
    minute = read_digits(t + 4, 2);
    t += 6;
    if (*t == ':') {
      second = read_digits(t + 1, 2);
      t += 3;
      if (second < 0 || t[-1] == '\0') {
        return -1;
      }
      if (*t == '.') {
        int digits = 0;
        milli = 0;
        for (t++; is_digit(*t) && digits < 3; t++, digits++) {
          milli = milli * 10 + (*t - '0');
        }
        if (digits == 0) {
          return -1;
        }
        for (; digits < 3; digits++) {
          milli *= 10;
        }
      }
    }
    if (*t != '\0') {
      return -1;
    }
  }
  if (month < 1 || month > 12 || day < 1 || day > days_in_month(year, month) || hour < 0 ||
      hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return -1;
  }
  *days = days_from_civil(year, month, day) - days_from_civil(1900, 1, 1);
  *ms = (((int64_t)hour * 60 + minute) * 60 + second) * 1000 + milli;
  return 0;
}

#define DATETIME_MIN_DAYS (-53690)  // 1753-01-01
#define DATETIME_MAX_DAYS 2958463   // 9999-12-31

/**
 * datetime: milliseconds to 1/300 s ticks as ASE converts a literal — to the
 * nearest tick, but never past the second's last one: 10:00:00.999 is stored
 * as 10:00:00.996, not 10:00:01.000 (checked against ASE 15.7, every ms).
 */
static int parse_bulk_datetime(const char *s, DBDATETIME *out, const char **why) {
  int64_t days, ms;
  if (parse_bulk_wall_clock(s, &days, &ms) != 0) {
    *why = "is not a date and time (YYYY-MM-DD HH:MM:SS.mmm)";
    return -1;
  }
  int64_t ticks_in_second = (ms % 1000 * 3 + 5) / 10;
  int64_t ticks = ms / 1000 * 300 + (ticks_in_second > 299 ? 299 : ticks_in_second);
  if (days < DATETIME_MIN_DAYS || days > DATETIME_MAX_DAYS) {
    *why = "is out of range for datetime (1753-01-01 to 9999-12-31)";
    return -1;
  }
  out->dtdays = (DBINT)days;
  out->dttime = (DBINT)ticks;
  return 0;
}

#define SMALLDATETIME_MAX_DAYS 65535  // 2079-06-06

/** smalldatetime: whole minutes, from 30.000 s rounding up, as ASE converts a literal. */
static int parse_bulk_smalldatetime(const char *s, DBDATETIME4 *out, const char **why) {
  int64_t days, ms;
  if (parse_bulk_wall_clock(s, &days, &ms) != 0) {
    *why = "is not a date and time (YYYY-MM-DD HH:MM:SS)";
    return -1;
  }
  int64_t minutes = ms / 60000 + (ms % 60000 >= 30000 ? 1 : 0);
  // The written date must be in range: ASE refuses 1899-12-31 23:59:59 rather
  // than round it up to 1900-01-01 (and 2079-06-06 23:59:30, which rounds past
  // the end). Checked against ASE 15.7.
  if (days < 0) {
    *why = "is out of range for smalldatetime (1900-01-01 to 2079-06-06)";
    return -1;
  }
  if (minutes >= 1440) {
    days++, minutes -= 1440;
  }
  if (days < 0 || days > SMALLDATETIME_MAX_DAYS) {
    *why = "is out of range for smalldatetime (1900-01-01 to 2079-06-06)";
    return -1;
  }
  out->days = (DBUSMALLINT)days;
  out->minutes = (DBUSMALLINT)minutes;
  return 0;
}

/** `[+-]?(digits[.digits?] | .digits)([eE][+-]?digits)?`, finite and in range. */
static int parse_bulk_float(const char *s, int real, double *out, const char **why) {
  const char *p = s;
  int digits = 0;
  int nonzero = 0;  // a mantissa digit other than 0: the value is not zero
  if (*p == '-' || *p == '+') {
    p++;
  }
  for (; is_digit(*p); p++) {
    digits++;
    nonzero |= *p != '0';
  }
  if (*p == '.') {
    for (p++; is_digit(*p); p++) {
      digits++;
      nonzero |= *p != '0';
    }
  }
  if (digits > 0 && (*p == 'e' || *p == 'E')) {
    p++;
    if (*p == '-' || *p == '+') {
      p++;
    }
    if (!is_digit(*p)) {
      digits = 0;
    }
    while (is_digit(*p)) {
      p++;
    }
  }
  char *end = NULL;
  double v = digits > 0 && *p == '\0' ? strtod(s, &end) : 0;
  // strtod reads the process locale's decimal point: under one with a comma it
  // stops at the '.', and the value is refused rather than misread.
  if (digits == 0 || *p != '\0' || end != p) {
    *why = "is not a number";
    return -1;
  }
  if (!isfinite(v) || (real && fabs(v) > FLT_MAX)) {
    *why = "is out of range for the column";
    return -1;
  }
  // Too small to hold: it would be stored as 0. (A subnormal that keeps a value
  // is fine, though strtod may flag it ERANGE: what counts is the result.)
  if (nonzero && (v == 0 || (real && (float)v == 0))) {
    *why = "is too small for the column: it would be stored as 0";
    return -1;
  }
  *out = v;
  return 0;
}

static int hex_value(unsigned c) {
  if (c >= '0' && c <= '9') {
    return (int)(c - '0');
  }
  if (c >= 'a' && c <= 'f') {
    return (int)(c - 'a' + 10);
  }
  if (c >= 'A' && c <= 'F') {
    return (int)(c - 'A' + 10);
  }
  return -1;
}

/**
 * A value that cannot be converted for a reason that is not the value's — out
 * of memory, db-lib refusing a binding. Unlike a refused value (-1), which
 * maxErrors may skip, this stops the copy: a valid row must not be left out.
 */
#define BULK_FATAL (-2)

/** Make room for `n` bytes of text scratch. */
static int bulk_reserve_text(BulkState *st, size_t n) {
  if (st->text_cap >= n) {
    return 0;
  }
  unsigned char *grown = (unsigned char *)realloc(st->text, n);
  if (!grown) {
    return -1;
  }
  st->text = grown;
  st->text_cap = n;
  return 0;
}

/** The next code point of UTF-8 `s` (length `n`) at `*i`, or -1 if it is not valid UTF-8. */
static int32_t utf8_next(const unsigned char *s, size_t n, size_t *i) {
  unsigned char b = s[*i];
  int needed;
  int32_t cp;
  unsigned char lower = 0x80, upper = 0xBF;
  if (b <= 0x7F) {
    (*i)++;
    return b;
  } else if (b >= 0xC2 && b <= 0xDF) {
    needed = 1, cp = b & 0x1F;
  } else if (b >= 0xE0 && b <= 0xEF) {
    needed = 2, cp = b & 0x0F;
    lower = b == 0xE0 ? 0xA0 : 0x80;
    upper = b == 0xED ? 0x9F : 0xBF;
  } else if (b >= 0xF0 && b <= 0xF4) {
    needed = 3, cp = b & 0x07;
    lower = b == 0xF0 ? 0x90 : 0x80;
    upper = b == 0xF4 ? 0x8F : 0xBF;
  } else {
    return -1;
  }
  if (n - *i <= (size_t)needed) {
    return -1;
  }
  for (int k = 1; k <= needed; k++) {
    unsigned char c = s[*i + (size_t)k];
    if (c < lower || c > upper) {
      return -1;
    }
    lower = 0x80, upper = 0xBF;
    cp = (cp << 6) | (c & 0x3F);
  }
  *i += (size_t)needed + 1;
  return cp;
}

/**
 * A text field in the server's encoding, in `st->text`: Latin-1 for an iso_1
 * server, otherwise UTF-8 (as SQL text is sent; see sql_bytes). Returns the
 * length, or -1 with `why` set.
 */
static long bulk_encode_text(BulkState *st, const BulkField *f, int latin1, char *why,
                             size_t why_size) {
  if (bulk_reserve_text(st, f->length * 3 + 1) != 0) {
    snprintf(why, why_size, "could not be converted: out of memory");
    return BULK_FATAL;
  }
  unsigned char *out = st->text;
  size_t len = 0;
  size_t i = 0;
  long chars = 0;
  while (i < f->length) {
    int32_t cp;
    chars++;
    if (f->units) {
      uint32_t u = f->units[i++];
      if (u >= 0xD800 && u <= 0xDBFF && i < f->length && f->units[i] >= 0xDC00 &&
          f->units[i] <= 0xDFFF) {
        cp = (int32_t)(0x10000 + ((u - 0xD800) << 10) + (f->units[i++] - 0xDC00));
      } else if (u >= 0xD800 && u <= 0xDFFF) {
        snprintf(why, why_size, "has an unpaired surrogate at character %ld", chars);
        return -1;
      } else {
        cp = (int32_t)u;
      }
    } else {
      cp = utf8_next(f->bytes, f->length, &i);
      if (cp < 0) {
        snprintf(why, why_size, "is not valid UTF-8 (at character %ld)", chars);
        return -1;
      }
    }
    // db-lib takes a lone NUL for an empty string (stored as a space): NUL in
    // text is refused, as in SQL, rather than stored as something else.
    if (cp == 0) {
      snprintf(why, why_size, "has a NUL character at character %ld", chars);
      return -1;
    }
    if (latin1) {
      if (cp > 0xFF) {
        snprintf(why, why_size,
                 "has U+%04X at character %ld, which the server's character set (iso_1) "
                 "cannot hold",
                 (unsigned)cp, chars);
        return -1;
      }
      out[len++] = (unsigned char)cp;
    } else if (cp < 0x80) {
      out[len++] = (unsigned char)cp;
    } else if (cp < 0x800) {
      out[len++] = (unsigned char)(0xC0 | (cp >> 6));
      out[len++] = (unsigned char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out[len++] = (unsigned char)(0xE0 | (cp >> 12));
      out[len++] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
      out[len++] = (unsigned char)(0x80 | (cp & 0x3F));
    } else {
      // Never past a 4-byte sequence: f->length * 3 covers it, since a code
      // point past U+FFFF takes two units or four UTF-8 bytes of input.
      out[len++] = (unsigned char)(0xF0 | (cp >> 18));
      out[len++] = (unsigned char)(0x80 | ((cp >> 12) & 0x3F));
      out[len++] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F));
      out[len++] = (unsigned char)(0x80 | (cp & 0x3F));
    }
  }
  return (long)len;
}

/**
 * Put one non-NULL value into the column's bound buffer and set its length.
 * Returns -1 with `why` set if the value does not convert exactly.
 */
static int bulk_set_value(SybaseConnection *conn, BulkState *st, const BulkColumn *col,
                          int table_column, const BulkField *f, char *why, size_t why_size) {
  char token[BULK_TOKEN_MAX];
  const char *reason = NULL;
  DBINT length = -1;

  if (col->kind == BULK_TEXT) {
    // Trailing blanks are not data (see below): left out before anything is
    // sized by the field. What is left cannot fit if even its shortest encoding
    // is too long — a byte per UTF-16 unit, or, from UTF-8 into Latin-1, a byte
    // per two (every character Latin-1 holds is at most two bytes of UTF-8).
    BulkField trimmed = *f;
    while (trimmed.length > 0 &&
           (f->units ? f->units[trimmed.length - 1] : f->bytes[trimmed.length - 1]) == ' ') {
      trimmed.length--;
    }
    size_t per_byte = !f->units && conn->latin1 ? 2 : 1;
    if (trimmed.length > (size_t)col->max_length * per_byte) {
      snprintf(why, why_size,
               "is at least %zu bytes in the server's character set; the column holds %d",
               (trimmed.length + per_byte - 1) / per_byte, col->max_length);
      return -1;
    }
    long n = bulk_encode_text(st, &trimmed, conn->latin1, why, why_size);
    if (n < 0) {
      return (int)n;
    }
    // ASE keeps no trailing blanks in varchar, and pads char with them, so they
    // are not data: dropped before the length is checked, as db-lib would.
    while (n > 0 && st->text[n - 1] == ' ') {
      n--;
    }
    if (n > col->max_length) {
      snprintf(why, why_size, "is %ld bytes in the server's character set; the column holds %d",
               n, col->max_length);
      return -1;
    }
    if (n == 0) {
      // Zero length would be NULL. ASE stores an empty string as one blank.
      col->buf[0] = ' ';
      n = 1;
    } else {
      memcpy(col->buf, st->text, (size_t)n);
    }
    return bcp_collen(conn->dbproc, (DBINT)n, table_column) == FAIL ? BULK_FATAL : 0;
  }

  if (col->kind == BULK_BINARY) {
    size_t start = 0;
    unsigned c0 = f->length > 0 ? (f->units ? f->units[0] : f->bytes[0]) : 0;
    unsigned c1 = f->length > 1 ? (f->units ? f->units[1] : f->bytes[1]) : 0;
    if (c0 == '0' && (c1 == 'x' || c1 == 'X')) {
      start = 2;
    }
    size_t digits = f->length - start;
    if (digits == 0 || digits % 2 != 0) {
      snprintf(why, why_size, "is not hexadecimal bytes (an even, non-zero number of hex digits)");
      return -1;
    }
    if (digits / 2 > (size_t)col->max_length) {
      snprintf(why, why_size, "is %zu bytes; the column holds %d", digits / 2, col->max_length);
      return -1;
    }
    for (size_t i = 0; i < digits / 2; i++) {
      size_t at = start + i * 2;
      int hi = hex_value(f->units ? f->units[at] : f->bytes[at]);
      int lo = hex_value(f->units ? f->units[at + 1] : f->bytes[at + 1]);
      if (hi < 0 || lo < 0) {
        snprintf(why, why_size, "is not hexadecimal bytes");
        return -1;
      }
      col->buf[i] = (BYTE)(hi << 4 | lo);
    }
    return bcp_collen(conn->dbproc, (DBINT)(digits / 2), table_column) == FAIL ? BULK_FATAL : 0;
  }

  if (bulk_ascii(f, token) != 0) {
    snprintf(why, why_size, "is not a valid %s value", syb_type_name(col->type));
    return -1;
  }
  switch (col->kind) {
    case BULK_INT: {
      int64_t v;
      if (parse_bulk_int(token, col->min, col->max, &v) != 0) {
        reason = "is not an integer in the column's range";
        break;
      }
      DBBIGINT big = v;
      memcpy(col->buf, &big, sizeof(big));
      break;
    }
    case BULK_BIT:
      if (strcmp(token, "0") != 0 && strcmp(token, "1") != 0) {
        reason = "is not a bit (0 or 1)";
        break;
      }
      col->buf[0] = (BYTE)(token[0] == '1');
      break;
    case BULK_FLOAT: {
      double v;
      if (parse_bulk_float(token, col->type == SYBREAL, &v, &reason) == 0) {
        DBFLT8 d = v;
        memcpy(col->buf, &d, sizeof(d));
      }
      break;
    }
    case BULK_MONEY: {
      DBMONEY m;
      if (parse_bulk_money(token, col, &m, &reason) == 0) {
        memcpy(col->buf, &m, sizeof(m));
      }
      break;
    }
    case BULK_NUMERIC: {
      DBNUMERIC num;
      if (parse_bulk_numeric(token, col, &num, &reason) == 0) {
        memcpy(col->buf, &num, sizeof(num));
        length = (DBINT)sizeof(num);
      }
      break;
    }
    case BULK_DATETIME: {
      DBDATETIME dt;
      if (parse_bulk_datetime(token, &dt, &reason) == 0) {
        memcpy(col->buf, &dt, sizeof(dt));
      }
      break;
    }
    case BULK_SMALLDATETIME: {
      DBDATETIME4 dt;
      if (parse_bulk_smalldatetime(token, &dt, &reason) == 0) {
        memcpy(col->buf, &dt, sizeof(dt));
      }
      break;
    }
    default:
      reason = "cannot be copied: the column type is not supported";
      break;
  }
  if (reason) {
    snprintf(why, why_size, "%s", reason);
    return -1;
  }
  return bcp_collen(conn->dbproc, length, table_column) == FAIL ? BULK_FATAL : 0;
}

// --- Async work --------------------------------------------------------------

typedef enum { BULK_OP_BEGIN, BULK_OP_SEND } BulkOp;

/** What a bulkSend call ends with (see the `commit` option). */
typedef enum { BULK_COMMIT_NONE = 0, BULK_COMMIT_BATCH = 1, BULK_COMMIT_DONE = 2 } BulkCommit;

/** Whether the rows of the open batch are committed after a failure. */
typedef enum {
  BULK_OUTCOME_NONE,     // no commit was attempted: the open batch is not committed
  BULK_OUTCOME_FAILED,   // the server refused the batch: not committed
  BULK_OUTCOME_UNKNOWN,  // the answer to the commit was lost: it may or may not have committed
} BulkOutcome;

/** Most rejected rows reported with their reason per call; more are only counted. */
#define BULK_MAX_REJECT_DETAILS 1000

/** A bound column as bulkBegin describes it to JS. */
typedef struct {
  char *name;
  const char *type;
  int nullable, length, precision, scale;
} BulkOutColumn;

typedef struct {
  int64_t row;
  char *column;      // whole, as in error_column; NULL for the row as a whole
  char message[288]; // "value " + a reason (up to 256)
} BulkReject;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  SybaseConnection *conn;
  int holds_conn;
  HandleClaim claim;
  BulkOp op;
  int hard_timeout_ms;
  Watchdog wd;
  // bulkBegin
  char *table;
  char **names;  // NULL: the default columns
  int num_names;
  int keep_identity;
  int ignore_defaults;
  int allow_constraint_bypass;
  int timeout_seconds;
  BulkState *state;  // being built; handed to the connection on success
  // Description of the bound columns, for JS (copied: JS must not reach into conn).
  BulkOutColumn *out;
  int out_count;
  // bulkSend
  unsigned char *data;  // TSV, UTF-8
  size_t data_len;
  uint16_t *units;      // value rows: every field back to back, UTF-16
  size_t num_units;
  uint32_t *lens;       // value rows: units per field, BULK_NULL for NULL
  size_t num_lens;
  int64_t rows;
  int64_t first_row;    // 1-based number of the chunk's first row in the whole copy
  int64_t max_rejects;  // rows that may still be rejected before the copy fails
  int commit;
  int64_t rows_sent;
  BulkReject *rejects;
  int num_rejects;
  int64_t rejected_count;
  int64_t committed;    // rows the server reports committed by this call; -1 if none
  int outcome;
  int finished;         // the copy has ended (BULK_COMMIT_DONE succeeded)
  int discard;          // finished, but the session could not be restored
  // Result
  char error[ERR_BUF_SIZE];
  int success;
  int reusable;         // failed, but the connection was left as it was
  int64_t error_row;    // 0 when the failure is not about a row
  int value_refused;    // failed on a refused value (past maxRejects), not the server or connection
  char *error_column;   // the column a failed row failed on, if any
  int conn_dead;
  int conn_lost;        // the connection itself broke (not just marked unusable)
  int conn_timed_out;
} BulkWork;

/** Field length marking a NULL in value rows. */
#define BULK_NULL 0xFFFFFFFFu

static void bulk_work_free(BulkWork *w) {
  free(w->table);
  for (int i = 0; i < w->num_names; i++) {
    free(w->names[i]);
  }
  free(w->names);
  bulk_state_free(w->state);
  for (int i = 0; i < w->out_count; i++) {
    free(w->out[i].name);
  }
  free(w->out);
  free(w->data);
  free(w->units);
  free(w->lens);
  for (int i = 0; i < w->num_rejects; i++) {
    free(w->rejects[i].column);
  }
  free(w->rejects);
  free(w->error_column);
  free(w);
}

/** Run a statement whose results are not needed; -1 (error in conn->last_error) on failure. */
static int run_simple(SybaseConnection *conn, const char *sql) {
  if (dbcmd(conn->dbproc, sql) == FAIL || dbsqlexec(conn->dbproc) == FAIL) {
    if (!DBDEAD(conn->dbproc)) {
      dbcancel(conn->dbproc);
    }
    return -1;
  }
  RETCODE rc;
  while ((rc = dbresults(conn->dbproc)) != NO_MORE_RESULTS) {
    if (rc == FAIL || discard_rows(conn->dbproc) == FAIL) {
      if (!DBDEAD(conn->dbproc)) {
        dbcancel(conn->dbproc);
      }
      return -1;
    }
  }
  return conn->has_error ? -1 : 0;
}

/** The connection's error text, or `fallback`, as the work's error. */
static void bulk_fail(BulkWork *w, const char *fallback) {
  if (w->conn->has_error) {
    snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
  } else {
    snprintf(w->error, sizeof(w->error), "%s", fallback);
  }
  w->success = 0;
}

/**
 * The catalog's database for `table` as SQL: the session's own temporary
 * database for a #temp table (not always `tempdb`), the named one for
 * `db.owner.table` / `db..table`, else the current one.
 */
static void catalog_db(const char *table, char *out, size_t size) {
  const char *dot = strchr(table, '.');
  if (table[0] == '#') {
    snprintf(out, size, "db_name(@@tempdbid)");
  } else if (dot && strchr(dot + 1, '.')) {
    snprintf(out, size, "'%.*s'", (int)(dot - table), table);
  } else {
    snprintf(out, size, "db_name()");
  }
}

/**
 * Read `@@trancount`, the table's columns, and what of the table a bulk copy
 * does not apply — insert triggers, CHECK and foreign key constraints, rules
 * — in one round trip. A copy is refused inside a transaction: each batch it
 * commits would then be part of that transaction, and "committed" would not
 * mean committed. And it is refused into a table with any of those, unless
 * the caller allows it: rows that break them would be stored.
 */
static int bulk_read_table(BulkWork *w, BulkState *st) {
  SybaseConnection *conn = w->conn;
  char db[128];
  catalog_db(w->table, db, sizeof(db));
  size_t sql_size = strlen(w->table) * 2 + strlen(db) + 1024;
  char *sql = (char *)malloc(sql_size);
  if (!sql) {
    snprintf(w->error, sizeof(w->error), "Out of memory");
    return -1;
  }
  // The table name is plain identifiers (is_table_name), so safe inside the
  // quoted dynamic SQL; the database's name need not be, so it is bracketed.
  // sysconstraints also lists computed columns (status 256): only referential
  // (64) and CHECK (128) constraints count. syscolumns.domain is the rule or
  // CHECK constraint in effect on a column (one bound to its user-defined type
  // included): only whether there are any matters here. In chained mode every
  // select opens a transaction (an IF does not): nothing is read then, and the
  // batch returns no result at all — the copy is refused with the connection
  // as it was.
  snprintf(sql, sql_size,
           "if @@tranchained = 1 or @@trancount > 0 begin\n"
           "if @@tranchained = 0 select @@trancount\n"
           "end else begin\n"
           "select @@trancount\n"
           "select * from %s where 1 = 0\n"
           "declare @db varchar(255) select @db = str_replace(%s, ']', ']]')\n"
           "exec('select o.instrig,"
           " (select count(*) from [' + @db + ']..sysconstraints c"
           " where c.tableid = o.id and c.status & 192 <> 0),"
           " (select count(*) from [' + @db + ']..syscolumns c where c.id = o.id and c.domain <> 0)"
           " from [' + @db + ']..sysobjects o where o.id = object_id(''%s'')')\n"
           "end",
           w->table, db, w->table);
  int ok = dbcmd(conn->dbproc, sql) != FAIL && dbsqlexec(conn->dbproc) != FAIL;
  free(sql);
  int set = 0;
  int trancount = -1;
  DBINT unapplied[3] = {-1, -1, -1};  // insert trigger, constraints, columns with a rule or CHECK
  RETCODE rc;
  while (ok && (rc = dbresults(conn->dbproc)) != NO_MORE_RESULTS) {
    if (rc == FAIL) {
      ok = 0;
      break;
    }
    int ncols = dbnumcols(conn->dbproc);
    if (ncols <= 0) {
      ok = discard_rows(conn->dbproc) != FAIL;
      continue;
    }
    if (++set == 1) {
      RETCODE row;
      while ((row = dbnextrow(conn->dbproc)) == REG_ROW) {
        BYTE *data = dbdata(conn->dbproc, 1);
        if (data && dbdatlen(conn->dbproc, 1) == (int)sizeof(DBINT)) {
          DBINT v;
          memcpy(&v, data, sizeof(v));
          trancount = v;
        }
      }
      ok = row != FAIL;
      continue;
    }
    if (set == 3) {
      RETCODE row;
      while ((row = dbnextrow(conn->dbproc)) == REG_ROW) {
        for (int i = 0; i < 3 && i < ncols; i++) {
          BYTE *data = dbdata(conn->dbproc, i + 1);
          if (data && dbdatlen(conn->dbproc, i + 1) == (int)sizeof(DBINT)) {
            memcpy(&unapplied[i], data, sizeof(DBINT));
          }
        }
      }
      ok = row != FAIL;
      continue;
    }
    if (st->columns == NULL) {
      st->columns = (BulkColumn *)calloc((size_t)ncols, sizeof(BulkColumn));
      if (!st->columns) {
        snprintf(w->error, sizeof(w->error), "Out of memory");
        dbcancel(conn->dbproc);
        return -1;
      }
      st->num_columns = ncols;
      for (int i = 0; i < ncols; i++) {
        BulkColumn *col = &st->columns[i];
        DBCOL info;
        memset(&info, 0, sizeof(info));
        info.SizeOfStruct = sizeof(info);
        const char *name = dbcolname(conn->dbproc, i + 1);
        col->name = dup_text(name ? name : "", conn->latin1);
        col->type = column_type(conn->dbproc, i + 1);
        col->usertype = dbcolutype(conn->dbproc, i + 1);
        col->max_length = dbcollen(conn->dbproc, i + 1);
        // Precision, scale, nullability and identity decide how values are
        // converted and which columns may be left out: without them the copy
        // does not start, rather than take every column for a NOT NULL one.
        if (dbcolinfo(conn->dbproc, CI_REGULAR, i + 1, 0, &info) != SUCCEED) {
          snprintf(w->error, sizeof(w->error), "Could not read column %d of %s", i + 1, w->table);
          dbcancel(conn->dbproc);
          return -1;
        }
        col->precision = info.Precision;
        col->scale = info.Scale;
        col->nullable = info.Null != 0;
        col->identity = info.Identity != 0;
        if (!col->name) {
          snprintf(w->error, sizeof(w->error), "Out of memory");
          dbcancel(conn->dbproc);
          return -1;
        }
        bulk_classify(col);
      }
    }
    ok = discard_rows(conn->dbproc) != FAIL;
  }
  if (!ok || conn->has_error) {
    bulk_fail(w, "Could not read the table's columns");
    if (!DBDEAD(conn->dbproc)) {
      dbcancel(conn->dbproc);
    }
    return -1;
  }
  // No result at all: chained mode (see above).
  if (set == 0) {
    snprintf(w->error, sizeof(w->error),
             "A bulk copy cannot run in chained transaction mode (set chained on): each statement "
             "opens a transaction, and the batches it commits must be committed for good. Run it "
             "with chained mode off");
    return -1;
  }
  if (trancount > 0) {
    snprintf(w->error, sizeof(w->error),
             "A bulk copy cannot run inside a transaction (@@trancount is %d): each batch it "
             "commits must be committed for good",
             trancount);
    return -1;
  }
  if (st->columns == NULL || trancount < 0) {
    bulk_fail(w, "Could not read the table's columns");
    return -1;
  }
  if (unapplied[0] < 0 || unapplied[1] < 0 || unapplied[2] < 0) {
    snprintf(w->error, sizeof(w->error), "Could not read whether %s has constraints or triggers",
             w->table);
    return -1;
  }
  if (!w->allow_constraint_bypass && (unapplied[0] || unapplied[1] || unapplied[2])) {
    snprintf(w->error, sizeof(w->error),
             "%s has %s, which a bulk copy does not apply (nor does the bcp utility): rows that "
             "break them would be stored. Load it through a staging table and an insert ... "
             "select, or pass allowConstraintBypass: true to copy anyway",
             w->table,
             unapplied[0] ? "an insert trigger"
             : unapplied[1] ? "CHECK or foreign key constraints"
                            : "a rule or CHECK constraint on a column");
    return -1;
  }
  return 0;
}

/** Choose the bound columns: the named ones, or every loadable one in table order. */
static int bulk_bind_columns(BulkWork *w, BulkState *st) {
  int capacity = w->names ? w->num_names : st->num_columns;
  st->bound = (int *)calloc((size_t)(capacity > 0 ? capacity : 1), sizeof(int));
  if (!st->bound) {
    snprintf(w->error, sizeof(w->error), "Out of memory");
    return -1;
  }
  if (w->names) {
    for (int n = 0; n < w->num_names; n++) {
      int found = -1;
      for (int i = 0; i < st->num_columns; i++) {
        if (strcmp(st->columns[i].name, w->names[n]) == 0) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        snprintf(w->error, sizeof(w->error), "Table %s has no column '%s'", w->table, w->names[n]);
        return -1;
      }
      for (int k = 0; k < st->num_bound; k++) {
        if (st->bound[k] == found) {
          snprintf(w->error, sizeof(w->error), "Column '%s' is listed twice", w->names[n]);
          return -1;
        }
      }
      st->bound[st->num_bound++] = found;
    }
  } else {
    for (int i = 0; i < st->num_columns; i++) {
      const BulkColumn *col = &st->columns[i];
      if ((col->identity && !w->keep_identity) || col->usertype == USERTYPE_TIMESTAMP) {
        continue;
      }
      st->bound[st->num_bound++] = i;
    }
  }
  if (st->num_bound == 0) {
    snprintf(w->error, sizeof(w->error), "No columns to copy into %s", w->table);
    return -1;
  }
  for (int k = 0; k < st->num_bound; k++) {
    BulkColumn *col = &st->columns[st->bound[k]];
    if (col->kind == BULK_UNSUPPORTED) {
      snprintf(w->error, sizeof(w->error),
               "Column '%s' (%s) cannot be bulk copied; leave it out of `columns`", col->name,
               col->usertype == USERTYPE_TIMESTAMP          ? "timestamp"
               : col->usertype == 34 || col->usertype == 35 ? "unichar/univarchar"
                                                            : syb_type_name(col->type));
      return -1;
    }
    if (col->identity && !w->keep_identity) {
      snprintf(w->error, sizeof(w->error),
               "Column '%s' is an identity column: the server assigns it, unless keepIdentity is "
               "set",
               col->name);
      return -1;
    }
  }
  int variable = 0;
  for (int i = 0; i < st->num_columns; i++) {
    const BulkColumn *col = &st->columns[i];
    // keepIdentity copies the identity values from the rows: they must give them.
    if (col->identity && w->keep_identity) {
      int bound = 0;
      for (int k = 0; k < st->num_bound && !bound; k++) {
        bound = st->bound[k] == i;
      }
      if (!bound) {
        snprintf(w->error, sizeof(w->error),
                 "keepIdentity copies the identity column's values, but '%s' is not among the "
                 "columns",
                 col->name);
        return -1;
      }
    }
    if (col->nullable || col->type == SYBVARCHAR || col->type == SYBVARBINARY ||
        col->type == SYBTEXT || col->type == SYBIMAGE) {
      variable++;
    }
  }
  // A bulk row's variable-length (or nullable) columns are counted in one byte,
  // in every row format: db-lib cannot send a row with more.
  if (variable > 255) {
    snprintf(w->error, sizeof(w->error),
             "%s has %d variable-length or nullable columns; a bulk copy supports at most 255",
             w->table, variable);
    return -1;
  }
  return 0;
}

/**
 * `set identity_insert <table> on|off`, marked in `st` once the server has
 * done it; -1 if it failed. (The table name is at most 92 characters: see
 * is_table_name.)
 */
static int bulk_identity_set(SybaseConnection *conn, BulkState *st, int on) {
  char sql[160];
  snprintf(sql, sizeof(sql), "set identity_insert %s %s", st->table, on ? "on" : "off");
  clear_error(conn);
  int rc = run_simple(conn, sql);
  if (rc == 0) {
    st->identity_insert = on;
  }
  return rc;
}

/** Undo `set identity_insert on`; -1 if that failed and the session is not as it was. */
static int bulk_identity_off(SybaseConnection *conn, BulkState *st) {
  return st->identity_insert ? bulk_identity_set(conn, st, 0) : 0;
}

static void bulk_begin(BulkWork *w) {
  SybaseConnection *conn = w->conn;
  w->reusable = 1;
  if (conn->bulk) {
    snprintf(w->error, sizeof(w->error), "A bulk copy is already in progress on this connection");
    return;
  }
  // Text is sent as the server's own row image (see the section comment): only
  // a character set it is converted to can be copied into exactly.
  if (!conn->latin1 && strcmp(conn->charset, "utf8") != 0) {
    snprintf(w->error, sizeof(w->error),
             "Bulk copy supports servers whose character set is iso_1 or utf8; this one's is %s",
             conn->charset);
    return;
  }
  BulkState *st = (BulkState *)calloc(1, sizeof(BulkState));
  if (!st || !(st->table = strdup(w->table))) {
    free(st);
    snprintf(w->error, sizeof(w->error), "Out of memory");
    return;
  }
  w->state = st;
  if (w->timeout_seconds > 0 && w->timeout_seconds != conn->timeout_seconds) {
    if (set_query_timeout(conn, w->timeout_seconds) != 0) {
      bulk_fail(w, "Could not set the copy's timeout");
      goto failed;
    }
    st->timeout_overridden = 1;
  }
  if (bulk_read_table(w, st) != 0 || bulk_bind_columns(w, st) != 0) {
    goto failed;
  }
  // identity_insert is marked on only once the server has turned it on: the
  // cleanup below turns off what is marked, and must not turn off a setting
  // this copy never made (the caller's own, say).
  for (int k = 0; k < st->num_bound; k++) {
    if (st->columns[st->bound[k]].identity) {
      if (bulk_identity_set(conn, st, 1) != 0) {
        bulk_fail(w, "Could not set identity_insert on");
        goto failed;
      }
      break;
    }
  }

  clear_error(conn);
  // bcp_init reads the table's layout again, for db-lib's own use. From here
  // on, a failure leaves db-lib holding the bound buffers, which are freed with
  // this work item: the connection must then not be used again.
  w->reusable = 0;
  if (bcp_init(conn->dbproc, st->table, NULL, NULL, DB_IN) == FAIL) {
    bulk_fail(w, "bcp_init() failed");
    goto failed;
  }
  // ASE bcp's --ignoredefaults: a NULL stays NULL instead of taking the column
  // default (patches/freetds-*-sybase-bulk.patch, from FreeTDS master).
  if (w->ignore_defaults &&
      bcp_options(conn->dbproc, BCPHINTS, (BYTE *)"KEEP_NULLS", (int)strlen("KEEP_NULLS")) == FAIL) {
    bulk_fail(w, "Could not set the KEEP_NULLS bulk copy hint");
    goto failed;
  }
  for (int k = 0; k < st->num_bound; k++) {
    BulkColumn *col = &st->columns[st->bound[k]];
    int size, host_type, varlen;
    bulk_binding(col, &size, &host_type, &varlen);
    col->buf = (BYTE *)calloc(1, (size_t)size);
    if (!col->buf) {
      snprintf(w->error, sizeof(w->error), "Out of memory");
      goto failed;
    }
    if (bcp_bind(conn->dbproc, col->buf, 0, varlen, NULL, 0, host_type, st->bound[k] + 1) == FAIL) {
      bulk_fail(w, "bcp_bind() failed");
      goto failed;
    }
  }
  // An identity column the rows do not give: on TDS 5.0 every row still
  // carries it, and with identity_insert off the server assigns the value in
  // place of what is sent. db-lib sends nothing for an unbound column and then
  // refuses the row, so it is bound to a constant 0.
  for (int i = 0; i < st->num_columns; i++) {
    BulkColumn *col = &st->columns[i];
    if (!col->identity || col->buf || (col->kind != BULK_INT && col->kind != BULK_NUMERIC)) {
      continue;
    }
    int size, host_type, varlen;
    bulk_binding(col, &size, &host_type, &varlen);
    col->buf = (BYTE *)calloc(1, (size_t)size);
    const char *why = NULL;
    if (!col->buf || (col->kind == BULK_NUMERIC &&
                      parse_bulk_numeric("0", col, (DBNUMERIC *)col->buf, &why) != 0)) {
      snprintf(w->error, sizeof(w->error), "Out of memory");
      goto failed;
    }
    if (bcp_bind(conn->dbproc, col->buf, 0, varlen, NULL, 0, host_type, i + 1) == FAIL) {
      bulk_fail(w, "bcp_bind() failed");
      goto failed;
    }
  }

  st->fields = (BulkField *)calloc((size_t)st->num_bound, sizeof(BulkField));
  st->is_null = (unsigned char *)calloc((size_t)st->num_bound, 1);
  if (!st->fields || !st->is_null) {
    snprintf(w->error, sizeof(w->error), "Out of memory");
    goto failed;
  }

  // The description JS encodes values by.
  w->out = (BulkOutColumn *)calloc((size_t)st->num_bound, sizeof(BulkOutColumn));
  if (!w->out) {
    snprintf(w->error, sizeof(w->error), "Out of memory");
    goto failed;
  }
  w->out_count = st->num_bound;
  for (int k = 0; k < st->num_bound; k++) {
    const BulkColumn *col = &st->columns[st->bound[k]];
    BulkOutColumn *out = &w->out[k];
    out->name = strdup(col->name);
    out->type = syb_type_name(col->type);
    out->nullable = col->nullable;
    out->length = col->max_length;
    out->precision = col->precision;
    out->scale = col->scale;
    if (!out->name) {
      snprintf(w->error, sizeof(w->error), "Out of memory");
      goto failed;
    }
  }
  conn->bulk = st;
  w->state = NULL;
  w->success = 1;
  return;

failed:
  // Nothing was sent to the server as bulk data yet: put the session back as it
  // was, or report that it is not.
  if (bulk_identity_off(conn, st) != 0) {
    w->reusable = 0;
  }
  if (restore_query_timeout(conn, st->timeout_overridden) != 0) {
    w->reusable = 0;
  }
  if (DBDEAD(conn->dbproc) || conn_is_dead(conn)) {
    w->reusable = 0;
  }
  w->success = 0;
}

static void bulk_reject(BulkWork *w, int64_t row, const char *column, const char *message) {
  w->rejected_count++;
  if (w->num_rejects >= BULK_MAX_REJECT_DETAILS) {
    return;
  }
  if (!w->rejects) {
    w->rejects = (BulkReject *)calloc(BULK_MAX_REJECT_DETAILS, sizeof(BulkReject));
    if (!w->rejects) {
      return;  // counted, without the detail
    }
  }
  BulkReject *r = &w->rejects[w->num_rejects++];
  r->row = row;
  r->column = column ? strdup(column) : NULL;
  snprintf(r->message, sizeof(r->message), "%s", message);
}

/** Fail the copy on row `row` (and `column`, if any) once too many rows were rejected. */
static int bulk_too_many_rejects(BulkWork *w, int64_t row, const char *column, const char *why) {
  if (w->rejected_count <= w->max_rejects) {
    return 0;
  }
  if (column) {
    snprintf(w->error, sizeof(w->error), "Row %lld, column '%s': %s", (long long)row, column, why);
    w->error_column = strdup(column);
  } else {
    snprintf(w->error, sizeof(w->error), "Row %lld: %s", (long long)row, why);
  }
  w->error_row = row;
  w->value_refused = 1;
  return -1;
}

/**
 * Why db-lib refused a row with SYBEBCNN, which does not say which column: a
 * NULL headed for a NOT NULL column without a default. Names the candidates.
 */
static void bulk_null_reason(BulkState *st, const unsigned char *is_null, char *out, size_t size) {
  int len = snprintf(out, size,
                     "a NULL for a column that allows none and has no default (candidates:");
  int listed = 0;
  for (int i = 0; i < st->num_columns && len > 0 && (size_t)len < size; i++) {
    const BulkColumn *col = &st->columns[i];
    if (col->nullable) {
      continue;
    }
    int k = 0;
    while (k < st->num_bound && st->bound[k] != i) {
      k++;
    }
    if (k == st->num_bound || is_null[k]) {
      len += snprintf(out + len, size - (size_t)len, "%s '%s'%s", listed ? "," : "", col->name,
                      k == st->num_bound ? " (not copied)" : "");
      listed++;
    }
  }
  if (len > 0 && (size_t)len < size) {
    snprintf(out + len, size - (size_t)len, ")");
  }
}

/**
 * Send one row whose fields are in `fields`. Returns 0 when the row was sent or
 * rejected (and may be skipped), -1 when the copy must stop (w->error set).
 */
static int bulk_send_row(BulkWork *w, BulkState *st, const BulkField *fields,
                         const unsigned char *is_null, int64_t row) {
  SybaseConnection *conn = w->conn;
  char why[256];
  for (int k = 0; k < st->num_bound; k++) {
    const BulkColumn *col = &st->columns[st->bound[k]];
    int table_column = st->bound[k] + 1;
    int rc;
    if (is_null[k]) {
      rc = bcp_collen(conn->dbproc, 0, table_column) == FAIL ? BULK_FATAL : 0;
      if (rc != 0) {
        snprintf(why, sizeof(why), "could not be bound");
      }
    } else {
      why[0] = '\0';
      rc = bulk_set_value(conn, st, col, table_column, &fields[k], why, sizeof(why));
      if (rc != 0 && why[0] == '\0') {
        snprintf(why, sizeof(why), "could not be bound");
      }
    }
    if (rc == BULK_FATAL) {
      // Not about the value: the copy stops, and its open batch is rolled back.
      snprintf(w->error, sizeof(w->error), "Row %lld, column '%s': the value %s", (long long)row,
               col->name, why);
      w->error_row = row;
      free(w->error_column);
      w->error_column = strdup(col->name);
      return -1;
    }
    if (rc != 0) {
      char message[sizeof(why) + 8];
      snprintf(message, sizeof(message), "value %s", why);
      bulk_reject(w, row, col->name, message);
      return bulk_too_many_rejects(w, row, col->name, message);
    }
  }

  clear_error(conn);
  if (bcp_sendrow(conn->dbproc) == SUCCEED) {
    st->started = 1;
    w->rows_sent++;
    return 0;
  }
  // Only a NULL the column refuses (db-lib reports SYBEBCNN for it) is about
  // this row. Anything else — the copy could not be opened, the connection
  // broke, or a failure db-lib did not report (out of memory) — stops the copy:
  // a row that may be valid is never skipped as a bad one.
  if (DBDEAD(conn->dbproc) || conn_is_dead(conn) || !conn->has_error ||
      conn->last_dberr != SYBEBCNN) {
    snprintf(w->error, sizeof(w->error), "Row %lld could not be sent: %.4000s", (long long)row,
             conn->has_error ? conn->last_error : "bcp_sendrow() failed");
    w->error_row = row;
    return -1;
  }
  st->started = 1;  // the copy is open: only this row was refused
  bulk_null_reason(st, is_null, why, sizeof(why));
  bulk_reject(w, row, NULL, why);
  return bulk_too_many_rejects(w, row, NULL, why);
}

/** End the batch (or the copy) as `w->commit` says; -1 (w->error set) on failure. */
static int bulk_commit(BulkWork *w, BulkState *st) {
  SybaseConnection *conn = w->conn;
  // Never commit for a caller that has already been told the copy failed: the
  // JS layer closes the connection when its deadline passes.
  uv_mutex_lock(&conn->lock);
  int abandoned = conn->pending_close || conn->dead;
  uv_mutex_unlock(&conn->lock);
  if (abandoned) {
    snprintf(w->error, sizeof(w->error), "The connection was closed before the batch was committed");
    w->outcome = BULK_OUTCOME_NONE;
    return -1;
  }
  clear_error(conn);
  DBINT rows;
  if (!st->started || st->reopen_failed) {
    // No row has reached the server: nothing to commit, and nothing to end —
    // bcp_done would fail with no copy open. db-lib keeps its copy state (and
    // pointers to the bound buffers freed with `st`) until the next bcp_init or
    // dbclose, which free it without reading those buffers.
    rows = 0;
  } else if (w->commit == BULK_COMMIT_BATCH) {
    rows = bcp_batch(conn->dbproc);
  } else {
    rows = bcp_done(conn->dbproc);
  }
  if (rows < 0) {
    int lost = DBDEAD(conn->dbproc) || conn_is_dead(conn) || conn->timed_out || !conn->has_error;
    w->outcome = lost ? BULK_OUTCOME_UNKNOWN : BULK_OUTCOME_FAILED;
    bulk_fail(w, "The server did not confirm the batch");
    return -1;
  }
  w->committed = rows;
  // Committed, but db-lib could not open the copy again (see bcp_batch): said
  // when the next rows come; a copy that has none left ends here.
  if (w->commit == BULK_COMMIT_BATCH && conn->has_error && conn->last_dberr == SYBEBULKINSERT) {
    st->reopen_failed = 1;
    // As much of the reason as fits.
    snprintf(st->reopen_error, sizeof(st->reopen_error), "%.*s", (int)sizeof(st->reopen_error) - 1,
             conn->last_error);
  }
  if (w->commit == BULK_COMMIT_DONE) {
    w->finished = 1;
    // db-lib's copy state is not what it should be: the connection is not reused.
    if (st->reopen_failed) {
      w->discard = 1;
    }
    if (bulk_identity_off(conn, st) != 0 || restore_query_timeout(conn, st->timeout_overridden) != 0) {
      w->discard = 1;  // the copy is done; the session could not be restored
    }
  }
  return 0;
}

/** Stop sending once the hard timeout has fired or the connection was closed (checked every few rows). */
static int bulk_watchdog_fired(BulkWork *w, int64_t r) {
  if ((r + 1) % WATCHDOG_CHECK_ROWS != 0 || !call_abandoned(&w->wd, w->conn)) {
    return 0;
  }
  if (!watchdog_fired(&w->wd) && w->error[0] == '\0') {
    snprintf(w->error, sizeof(w->error), "The connection was closed during the copy");
  }
  return 1;
}

static void bulk_send(BulkWork *w) {
  SybaseConnection *conn = w->conn;
  BulkState *st = conn->bulk;
  w->committed = -1;
  if (!st) {
    snprintf(w->error, sizeof(w->error), "No bulk copy is in progress on this connection");
    w->reusable = 1;
    return;
  }
  // The copy could not be opened again after its last commit: nothing more can
  // be sent (db-lib would refuse each row without saying why).
  if (st->reopen_failed && w->rows > 0) {
    snprintf(w->error, sizeof(w->error),
             "The copy could not be opened again after its last committed batch: %s",
             st->reopen_error);
    w->error_row = w->first_row;
    w->outcome = BULK_OUTCOME_NONE;
    return;
  }
  BulkField *fields = st->fields;
  unsigned char *is_null = st->is_null;
  int failed = 0;
  int64_t row = w->first_row;
  if (w->data) {
    // TSV: fields split by tab, rows by newline (CRLF too), an empty field is NULL.
    const unsigned char *p = w->data, *end = w->data + w->data_len;
    // Exactly `rows` rows — each ending at a newline, but for a last one
    // without — checked as they are read, in the same pass: no row past the
    // data is sent, and data past the rows fails the chunk before its commit.
    // What was sent of it is then in a batch never committed (the connection
    // is given up: see BULK_OUTCOME_NONE), and rolled back.
    for (int64_t r = 0; r < w->rows && !failed; r++, row++) {
      if (p >= end) {
        snprintf(w->error, sizeof(w->error),
                 "Internal error: malformed bulk rows (%lld rows said, %lld given)",
                 (long long)w->rows, (long long)r);
        failed = 1;
        break;
      }
      const unsigned char *eol = p < end ? (const unsigned char *)memchr(p, '\n', (size_t)(end - p)) : NULL;
      const unsigned char *row_end = eol ? eol : end;
      const unsigned char *next = eol ? eol + 1 : end;
      // A CR only before the LF ending the row (CRLF): a last row without one
      // keeps a trailing CR as data.
      if (eol && row_end > p && row_end[-1] == '\r') {
        row_end--;
      }
      int count = 0;
      const unsigned char *field = p;
      for (;;) {
        const unsigned char *tab =
            (const unsigned char *)memchr(field, '\t', (size_t)(row_end - field));
        const unsigned char *field_end = tab ? tab : row_end;
        if (count < st->num_bound) {
          fields[count].bytes = field;
          fields[count].units = NULL;
          fields[count].length = (size_t)(field_end - field);
          is_null[count] = field_end == field;
        }
        count++;
        if (!tab) {
          break;
        }
        field = tab + 1;
      }
      p = next;
      if (count != st->num_bound) {
        char why[128];
        snprintf(why, sizeof(why), "has %d fields; %d columns are copied", count, st->num_bound);
        bulk_reject(w, row, NULL, why);
        failed = bulk_too_many_rejects(w, row, NULL, why) != 0;
      } else {
        failed = bulk_send_row(w, st, fields, is_null, row) != 0;
      }
      // Every row, sent or refused, reaches the stop check.
      failed = failed || bulk_watchdog_fired(w, r);
    }
    if (!failed && p < end) {
      snprintf(w->error, sizeof(w->error),
               "Internal error: malformed bulk rows (more data than the %lld rows said)",
               (long long)w->rows);
      failed = 1;
    }
  } else {
    // Value rows: every field's length, then all fields back to back.
    size_t unit = 0, field_index = 0;
    // Checked before multiplying: an absurd row count must not wrap around to
    // match the lengths given.
    int consistent = (uint64_t)w->rows <= SIZE_MAX / (size_t)st->num_bound &&
                     w->num_lens == (size_t)w->rows * (size_t)st->num_bound;
    for (size_t i = 0; consistent && i < w->num_lens; i++) {
      if (w->lens[i] != BULK_NULL) {
        consistent = w->lens[i] <= w->num_units - unit;
        unit += w->lens[i];
      }
    }
    if (!consistent || unit != w->num_units) {
      snprintf(w->error, sizeof(w->error), "Internal error: malformed bulk rows");
      failed = 1;
    }
    unit = 0;
    for (int64_t r = 0; r < w->rows && !failed; r++, row++) {
      for (int k = 0; k < st->num_bound; k++, field_index++) {
        uint32_t len = w->lens[field_index];
        is_null[k] = len == BULK_NULL;
        fields[k].bytes = NULL;
        fields[k].units = w->units + unit;
        fields[k].length = is_null[k] ? 0 : len;
        unit += fields[k].length;
      }
      failed = bulk_send_row(w, st, fields, is_null, row) != 0 || bulk_watchdog_fired(w, r);
    }
  }
  if (failed) {
    w->outcome = BULK_OUTCOME_NONE;
    return;
  }
  if (w->commit != BULK_COMMIT_NONE && bulk_commit(w, st) != 0) {
    return;
  }
  if (w->finished) {
    conn->bulk = NULL;
    bulk_state_free(st);
  }
  w->success = 1;
}

static void bulk_release_conn(BulkWork *w) {
  if (w->holds_conn) {
    w->holds_conn = 0;
    conn_release(w->conn);
  }
}

static void bulk_execute(napi_env env, void *data) {
  (void)env;
  BulkWork *w = (BulkWork *)data;
  if (!w->holds_conn) {
    snprintf(w->error, sizeof(w->error), "Connection is closed");
    w->conn_dead = 1;
    w->conn_lost = 1;
    return;
  }
  uv_mutex_lock(&w->conn->lock);
  int closing = w->conn->pending_close;
  uv_mutex_unlock(&w->conn->lock);
  if (closing || conn_is_dead(w->conn) || DBDEAD(w->conn->dbproc)) {
    snprintf(w->error, sizeof(w->error), closing ? "Connection is closed" : "Connection is dead");
    conn_mark_dead(w->conn);
    w->conn_dead = 1;
    w->conn_lost = 1;
    bulk_release_conn(w);
    return;
  }

  clear_error(w->conn);
  int started = watchdog_start(&w->wd, w->conn, w->hard_timeout_ms);
  if (started != 0) {
    // Nothing is sent without the hard timeout behind it (see query_execute),
    // nor once it has passed while the call was queued (reported below). A
    // copy already open cannot go on, though: its batch must be abandoned.
    snprintf(w->error, sizeof(w->error), "Could not start the hard-timeout watchdog");
    w->outcome = BULK_OUTCOME_NONE;
    w->reusable = w->op == BULK_OP_BEGIN && started < 0;
  } else {
    if (w->op == BULK_OP_BEGIN) {
      bulk_begin(w);
    } else {
      bulk_send(w);
    }
    watchdog_stop(&w->wd);
  }
  if (w->wd.fired) {
    // Whatever the call managed — `committed` still says what it committed —
    // the caller's deadline has passed.
    snprintf(w->error, sizeof(w->error),
             "Bulk copy exceeded hard timeout of %d ms — connection forcefully abandoned",
             w->hard_timeout_ms);
    if (w->success) {
      w->outcome = BULK_OUTCOME_NONE;
    }
    w->success = 0;
    w->reusable = 0;
  }
  // A copy that failed part way cannot go on, and its open batch is only rolled
  // back by closing the connection: never let it be used again.
  if (!w->success && !w->reusable) {
    conn_mark_dead(w->conn);
  }
  w->conn_lost = DBDEAD(w->conn->dbproc);
  w->conn_dead = conn_is_dead(w->conn);
  w->conn_timed_out = w->conn->timed_out;
  bulk_release_conn(w);
}

/** Set `name` on `obj` to a number. */
static napi_status set_number(napi_env env, napi_value obj, const char *name, double value) {
  napi_value v;
  NAPI_TRY(napi_create_double(env, value, &v));
  return napi_set_named_property(env, obj, name, v);
}

static napi_status set_bool(napi_env env, napi_value obj, const char *name, bool value) {
  napi_value v;
  NAPI_TRY(napi_get_boolean(env, value, &v));
  return napi_set_named_property(env, obj, name, v);
}

static napi_status set_string(napi_env env, napi_value obj, const char *name, const char *value) {
  napi_value v;
  NAPI_TRY(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &v));
  return napi_set_named_property(env, obj, name, v);
}

/** Rows sent, rejected and committed by a bulkSend call — on success and on failure alike. */
static napi_status set_send_progress(napi_env env, napi_value obj, const BulkWork *w) {
  NAPI_TRY(set_number(env, obj, "rowsSent", (double)w->rows_sent));
  NAPI_TRY(set_number(env, obj, "rejectedCount", (double)w->rejected_count));
  napi_value rejected, committed;
  NAPI_TRY(napi_create_array_with_length(env, (size_t)w->num_rejects, &rejected));
  for (int i = 0; i < w->num_rejects; i++) {
    napi_value item;
    NAPI_TRY(napi_create_object(env, &item));
    NAPI_TRY(set_number(env, item, "row", (double)w->rejects[i].row));
    if (w->rejects[i].column) {
      NAPI_TRY(set_string(env, item, "column", w->rejects[i].column));
    }
    NAPI_TRY(set_string(env, item, "message", w->rejects[i].message));
    NAPI_TRY(napi_set_element(env, rejected, (uint32_t)i, item));
  }
  NAPI_TRY(napi_set_named_property(env, obj, "rejected", rejected));
  if (w->committed >= 0) {
    return set_number(env, obj, "committed", (double)w->committed);
  }
  NAPI_TRY(napi_get_null(env, &committed));
  return napi_set_named_property(env, obj, "committed", committed);
}

/** The error a failed bulk call rejects with, with everything known about it. */
static napi_status bulk_error(napi_env env, const BulkWork *w, napi_value *error) {
  napi_value msg;
  NAPI_TRY(napi_create_string_utf8(env, w->error[0] ? w->error : "Bulk copy failed",
                                   NAPI_AUTO_LENGTH, &msg));
  NAPI_TRY(napi_create_error(env, NULL, msg, error));
  if (w->conn_dead) {
    NAPI_TRY(set_bool(env, *error, "connectionDead", true));
  }
  if (w->conn_lost) {
    NAPI_TRY(set_bool(env, *error, "connectionLost", true));
  }
  if (w->conn_timed_out) {
    NAPI_TRY(set_bool(env, *error, "timedOut", true));
  }
  if (w->wd.fired) {
    NAPI_TRY(set_bool(env, *error, "hardTimeout", true));
  }
  NAPI_TRY(set_bool(env, *error, "reusable", w->reusable && !w->conn_dead));
  if (w->op == BULK_OP_SEND) {
    static const char *const outcomes[] = {"none", "failed", "unknown"};
    NAPI_TRY(set_send_progress(env, *error, w));
    NAPI_TRY(set_string(env, *error, "outcome", outcomes[w->outcome]));
    if (w->error_row > 0) {
      NAPI_TRY(set_number(env, *error, "row", (double)w->error_row));
    }
    if (w->error_column) {
      NAPI_TRY(set_string(env, *error, "column", w->error_column));
    }
    if (w->value_refused && !w->wd.fired) {
      NAPI_TRY(set_bool(env, *error, "valueRefused", true));
    }
  }
  return napi_ok;
}

/** What a successful bulk call resolves to. */
static napi_status bulk_result(napi_env env, const BulkWork *w, napi_value *result) {
  NAPI_TRY(napi_create_object(env, result));
  if (w->op == BULK_OP_SEND) {
    NAPI_TRY(set_send_progress(env, *result, w));
    return set_bool(env, *result, "discard", w->discard != 0);
  }
  napi_value columns;
  NAPI_TRY(napi_create_array_with_length(env, (size_t)w->out_count, &columns));
  for (int k = 0; k < w->out_count; k++) {
    napi_value col;
    NAPI_TRY(napi_create_object(env, &col));
    const BulkOutColumn *out = &w->out[k];
    NAPI_TRY(set_string(env, col, "name", out->name));
    NAPI_TRY(set_string(env, col, "type", out->type));
    NAPI_TRY(set_bool(env, col, "nullable", out->nullable != 0));
    NAPI_TRY(set_number(env, col, "length", out->length));
    NAPI_TRY(set_number(env, col, "precision", out->precision));
    NAPI_TRY(set_number(env, col, "scale", out->scale));
    NAPI_TRY(napi_set_element(env, columns, (uint32_t)k, col));
  }
  return napi_set_named_property(env, *result, "columns", columns);
}

static void bulk_complete(napi_env env, napi_status status, void *data) {
  BulkWork *w = (BulkWork *)data;
  napi_value value;
  int failed = status == napi_cancelled || !w->success;
  napi_status built = failed ? bulk_error(env, w, &value) : bulk_result(env, w, &value);
  if (built != napi_ok) {
    // Typically V8 out of memory. The error carries no `outcome` or
    // `committed`: what the call committed, if it committed, is unknown to JS,
    // and it reports that rather than a guess.
    reject_fallback(env, w->deferred, "Could not hand the bulk copy's answer to JavaScript");
  } else if (failed) {
    napi_reject_deferred(env, w->deferred, value);
  } else {
    napi_resolve_deferred(env, w->deferred, value);
  }
  // A cancelled work item never ran bulk_execute, so its slot is still held.
  bulk_release_conn(w);
  release_handle(env, &w->claim);
  napi_delete_async_work(env, w->work);
  bulk_work_free(w);
}

/** A string option as a new UTF-8 string; NULL when absent, not a string, or holding a NUL. */
static char *get_string_option(napi_env env, napi_value obj, const char *name) {
  napi_value v;
  napi_valuetype type;
  size_t len = 0;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok ||
      napi_typeof(env, v, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) {
    return NULL;
  }
  char *out = (char *)malloc(len + 1);
  if (out) {
    napi_get_value_string_utf8(env, v, out, len + 1, &len);
    // Used as a C string: a NUL would make it another (shorter) name.
    if (strlen(out) != len) {
      free(out);
      return NULL;
    }
  }
  return out;
}

/** Queue a bulk work item on the connection behind `handle`; settles its promise on failure. */
static napi_value bulk_queue(napi_env env, BulkWork *w, napi_value handle_value,
                             ConnHandle *handle, const char *name) {
  if (!handle_available(handle)) {
    bulk_work_free(w);
    return busy_rejection(env);
  }
  // The hard timeout counts from now, not from when a worker picks it up.
  w->wd.queued_ns = uv_hrtime();
  if (claim_handle(env, handle_value, handle, &w->claim) != 0) {
    bulk_work_free(w);
    napi_throw_error(env, NULL, "Could not reference the connection handle");
    return NULL;
  }
  napi_value promise, work_name;
  if (napi_create_promise(env, &w->deferred, &promise) != napi_ok) {
    release_handle(env, &w->claim);
    bulk_work_free(w);
    napi_throw_error(env, NULL, "Could not create the bulk copy's promise");
    return NULL;
  }
  w->conn = handle->conn;
  // Pinned now, on the JS thread, as fn_query does.
  w->holds_conn = w->conn != NULL && conn_acquire(w->conn) == 0;
  napi_status st = napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &work_name);
  if (st == napi_ok) {
    st = napi_create_async_work(env, NULL, work_name, bulk_execute, bulk_complete, w, &w->work);
  }
  if (st == napi_ok) {
    st = napi_queue_async_work(env, w->work);
    if (st != napi_ok) {
      napi_delete_async_work(env, w->work);
    }
  }
  if (st != napi_ok) {
    bulk_release_conn(w);
    release_handle(env, &w->claim);
    // Nothing ran: the error says so (outcome "none", nothing committed), so
    // that it is not taken for a commit whose answer was lost.
    snprintf(w->error, sizeof(w->error), "Failed to schedule the bulk copy");
    w->committed = -1;
    w->outcome = BULK_OUTCOME_NONE;
    w->reusable = w->op == BULK_OP_BEGIN;
    napi_value err;
    if (bulk_error(env, w, &err) == napi_ok) {
      napi_reject_deferred(env, w->deferred, err);
    } else {
      reject_fallback(env, w->deferred, w->error);
    }
    bulk_work_free(w);
  }
  return promise;
}

/**
 * Whether `name` is a table name of plain identifiers — `table`, `owner.table`,
 * `db..table`, `db.owner.table`, `#temp` — and so safe to put in SQL as it is.
 */
static int is_table_name(const char *name) {
  if (!name[0] || strlen(name) > 92) {  // bcp_init's limit on TDS 5.0
    return 0;
  }
  for (const char *p = name; *p; p++) {
    char c = *p;
    if (!(c == '.' || c == '_' || c == '#' || c == '@' || c == '$' || is_digit(c) ||
          (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) {
      return 0;
    }
  }
  return 1;
}

// napi_value bulkBegin(conn, { table, columns?, keepIdentity?, ignoreDefaults?,
//                              allowConstraintBypass?, timeoutSeconds?, hardTimeoutMs })
//
// Opens a copy into `table` (see the section comment). Resolves to the bound
// columns, `{ columns: [{ name, type, nullable, length, precision, scale }] }`,
// in the order rows give their values. Failures carry `reusable`: whether the
// connection was left as it was.
static napi_value fn_bulk_begin(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  ConnHandle *handle = get_conn_handle(env, args[0]);
  if (handle == NULL) {
    return NULL;  // TypeError pending
  }
  napi_valuetype type = napi_undefined;
  if (argc < 2 || napi_typeof(env, args[1], &type) != napi_ok || type != napi_object) {
    napi_throw_type_error(env, NULL, "Expected bulk copy options");
    return NULL;
  }
  BulkWork *w = (BulkWork *)calloc(1, sizeof(BulkWork));
  if (!w) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  w->op = BULK_OP_BEGIN;
  w->table = get_string_option(env, args[1], "table");
  if (!w->table || !is_table_name(w->table)) {
    bulk_work_free(w);
    napi_throw_type_error(env, NULL, "Expected a table name of the form db.owner.table");
    return NULL;
  }
  // Every read below may run JavaScript (a getter) that throws: its exception
  // is left pending and nothing is queued.
  napi_value columns;
  napi_valuetype columns_type = napi_undefined;
  bool is_array = false;
  if (napi_get_named_property(env, args[1], "columns", &columns) != napi_ok ||
      napi_typeof(env, columns, &columns_type) != napi_ok ||
      napi_is_array(env, columns, &is_array) != napi_ok) {
    bulk_work_free(w);
    return NULL;
  }
  if (columns_type != napi_undefined && !is_array) {
    bulk_work_free(w);
    napi_throw_type_error(env, NULL, "Expected `columns` to be an array of column names");
    return NULL;
  }
  if (is_array) {
    uint32_t n = 0;
    if (napi_get_array_length(env, columns, &n) != napi_ok) {
      bulk_work_free(w);
      return NULL;
    }
    w->names = (char **)calloc(n > 0 ? n : 1, sizeof(char *));
    if (!w->names) {
      bulk_work_free(w);
      napi_throw_error(env, NULL, "Out of memory");
      return NULL;
    }
    for (uint32_t i = 0; i < n; i++) {
      napi_value item;
      size_t len = 0;
      napi_valuetype item_type = napi_undefined;
      if (napi_get_element(env, columns, i, &item) != napi_ok ||
          napi_typeof(env, item, &item_type) != napi_ok) {
        bulk_work_free(w);
        return NULL;
      }
      if (item_type != napi_string) {
        bulk_work_free(w);
        napi_throw_type_error(env, NULL, "Expected column names as strings");
        return NULL;
      }
      if (napi_get_value_string_utf8(env, item, NULL, 0, &len) != napi_ok) {
        bulk_work_free(w);
        return NULL;
      }
      w->names[i] = (char *)malloc(len + 1);
      w->num_names = (int)i + 1;
      if (!w->names[i]) {
        bulk_work_free(w);
        napi_throw_error(env, NULL, "Out of memory");
        return NULL;
      }
      if (napi_get_value_string_utf8(env, item, w->names[i], len + 1, &len) != napi_ok) {
        bulk_work_free(w);
        return NULL;
      }
      if (strlen(w->names[i]) != len) {
        bulk_work_free(w);
        napi_throw_type_error(env, NULL, "Expected column names without NUL characters");
        return NULL;
      }
    }
  }
  // A hard timeout is required: a copy never runs without its watchdog.
  if (option_bool(env, args[1], "keepIdentity", &w->keep_identity) != 0 ||
      option_bool(env, args[1], "ignoreDefaults", &w->ignore_defaults) != 0 ||
      option_bool(env, args[1], "allowConstraintBypass", &w->allow_constraint_bypass) != 0 ||
      config_int(env, args[1], "timeoutSeconds", 1, MAX_TIMEOUT_SECONDS, 0, &w->timeout_seconds) != 0 ||
      config_int(env, args[1], "hardTimeoutMs", 1, INT32_MAX, 1, &w->hard_timeout_ms) != 0) {
    bulk_work_free(w);
    return NULL;
  }
  return bulk_queue(env, w, args[0], handle, "sybase_bulk_begin");
}

// napi_value bulkSend(conn, { rows, firstRow, maxRejects, commit, hardTimeoutMs, tsv }
//                         | { rows, firstRow, maxRejects, commit, hardTimeoutMs, text, lens })
//
// Sends `rows` rows of the open copy: TSV (a Uint8Array or a string, UTF-8),
// or value rows — every field of every row back to back in the string `text`,
// with `lens` (a Uint32Array) holding each field's length in UTF-16 units,
// 0xFFFFFFFF for NULL. Then `commit`: 0 keeps the batch open, 1 commits it
// (bcp_batch), 2 commits it and ends the copy (bcp_done). Resolves to
// `{ rowsSent, rejectedCount, rejected, committed, discard }`; failures carry
// the same progress, plus `outcome`, `row` and `column`.
static napi_value fn_bulk_send(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  ConnHandle *handle = get_conn_handle(env, args[0]);
  if (handle == NULL) {
    return NULL;  // TypeError pending
  }
  napi_valuetype type = napi_undefined;
  if (argc < 2 || napi_typeof(env, args[1], &type) != napi_ok || type != napi_object) {
    napi_throw_type_error(env, NULL, "Expected bulk copy rows");
    return NULL;
  }
  BulkWork *w = (BulkWork *)calloc(1, sizeof(BulkWork));
  if (!w) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  w->op = BULK_OP_SEND;
  w->committed = -1;
  w->first_row = 1;
  w->commit = BULK_COMMIT_NONE;
  int64_t commit = BULK_COMMIT_NONE;
  if (option_int64(env, args[1], "rows", 0, MAX_SAFE_INTEGER, 1, &w->rows) != 0 ||
      option_int64(env, args[1], "firstRow", 1, MAX_SAFE_INTEGER, 0, &w->first_row) != 0 ||
      option_int64(env, args[1], "maxRejects", 0, MAX_SAFE_INTEGER, 0, &w->max_rejects) != 0 ||
      option_int64(env, args[1], "commit", BULK_COMMIT_NONE, BULK_COMMIT_DONE, 0, &commit) != 0 ||
      config_int(env, args[1], "hardTimeoutMs", 1, INT32_MAX, 1, &w->hard_timeout_ms) != 0) {
    bulk_work_free(w);
    return NULL;
  }
  w->commit = (int)commit;

  // The rows: TSV in `tsv`, or value rows in `text` and `lens`. Any read that
  // fails (a throwing getter) leaves its exception pending; nothing is queued.
  napi_value v, lens;
  napi_valuetype vtype = napi_undefined, ltype = napi_undefined;
  bool is_typed = false;
  int ok = 0;
  if (napi_get_named_property(env, args[1], "tsv", &v) != napi_ok ||
      napi_typeof(env, v, &vtype) != napi_ok) {
    bulk_work_free(w);
    return fail_call(env, "Could not read `tsv`");
  }
  if (vtype == napi_string) {
    size_t len = 0;
    if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) {
      bulk_work_free(w);
      return fail_call(env, "Could not read `tsv`");
    }
    w->data = (unsigned char *)malloc(len + 1);
    if (!w->data) {
      bulk_work_free(w);
      napi_throw_error(env, NULL, "Out of memory");
      return NULL;
    }
    if (napi_get_value_string_utf8(env, v, (char *)w->data, len + 1, &len) != napi_ok) {
      bulk_work_free(w);
      return fail_call(env, "Could not read `tsv`");
    }
    w->data_len = len;
    ok = 1;
  } else if (vtype != napi_undefined) {
    if (napi_is_typedarray(env, v, &is_typed) != napi_ok) {
      bulk_work_free(w);
      return fail_call(env, "Could not read `tsv`");
    }
    napi_typedarray_type ta_type = napi_int8_array;
    size_t length = 0;
    void *bytes = NULL;
    if (is_typed) {
      if (napi_get_typedarray_info(env, v, &ta_type, &length, &bytes, NULL, NULL) != napi_ok) {
        bulk_work_free(w);
        return fail_call(env, "Could not read `tsv`");
      }
    }
    if (is_typed && ta_type == napi_uint8_array) {
      // Copied: the worker must not read memory the JS heap owns.
      w->data = (unsigned char *)malloc(length > 0 ? length : 1);
      if (!w->data) {
        bulk_work_free(w);
        napi_throw_error(env, NULL, "Out of memory");
        return NULL;
      }
      if (length > 0) {
        memcpy(w->data, bytes, length);
      }
      w->data_len = length;
      ok = 1;
    }
  } else {
    if (napi_get_named_property(env, args[1], "text", &v) != napi_ok ||
        napi_typeof(env, v, &vtype) != napi_ok ||
        napi_get_named_property(env, args[1], "lens", &lens) != napi_ok ||
        napi_typeof(env, lens, &ltype) != napi_ok || napi_is_typedarray(env, lens, &is_typed) != napi_ok) {
      bulk_work_free(w);
      return fail_call(env, "Could not read `text` and `lens`");
    }
    napi_typedarray_type ta_type = napi_int8_array;
    size_t count = 0, units = 0;
    void *values = NULL;
    if (vtype == napi_string && is_typed) {
      if (napi_get_typedarray_info(env, lens, &ta_type, &count, &values, NULL, NULL) != napi_ok ||
          napi_get_value_string_utf16(env, v, NULL, 0, &units) != napi_ok) {
        bulk_work_free(w);
        return fail_call(env, "Could not read `text` and `lens`");
      }
    }
    if (vtype == napi_string && is_typed && ta_type == napi_uint32_array) {
      w->lens = (uint32_t *)malloc((count > 0 ? count : 1) * sizeof(uint32_t));
      w->units = (uint16_t *)malloc((units + 1) * sizeof(uint16_t));
      if (!w->lens || !w->units) {
        bulk_work_free(w);
        napi_throw_error(env, NULL, "Out of memory");
        return NULL;
      }
      if (count > 0) {
        memcpy(w->lens, values, count * sizeof(uint32_t));
      }
      if (napi_get_value_string_utf16(env, v, (char16_t *)w->units, units + 1, &units) != napi_ok) {
        bulk_work_free(w);
        return fail_call(env, "Could not read `text`");
      }
      w->num_lens = count;
      w->num_units = units;
      ok = 1;
    }
  }
  if (!ok) {
    bulk_work_free(w);
    napi_throw_type_error(env, NULL, "Expected bulk copy rows as `tsv`, or as `text` and `lens`");
    return NULL;
  }
  return bulk_queue(env, w, args[0], handle, "sybase_bulk_send");
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
    close_connection(conn, env, env_state(env));
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
    // db-lib's own state is read only while no call is in flight: a worker
    // changes it without this lock. A running call that finds the connection
    // dead marks `dead` (or closes it) itself.
    if (conn->dbproc && !conn->dead && !conn->pending_close &&
        (conn->in_flight > 0 || !DBDEAD(conn->dbproc))) {
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
  if (!dblib_ready) {
    napi_throw_error(env, NULL, "FreeTDS dbinit() failed");
    return exports;
  }
  // Marked closing by a cleanup hook: Node runs those in reverse order, so this
  // one runs before N-API's own, which runs the finalizers still pending.
  EnvState *state = (EnvState *)calloc(1, sizeof(EnvState));
  if (state != NULL) {
    state->refs = 1;  // the environment's, released by env_state_free
  }
  if (state == NULL || napi_set_instance_data(env, state, env_state_free, NULL) != napi_ok) {
    free(state);
    napi_throw_error(env, NULL, "drizzle-sybase: could not set up the addon");
    return exports;
  }
  if (napi_add_env_cleanup_hook(env, env_cleanup, state) != napi_ok) {
    napi_throw_error(env, NULL, "drizzle-sybase: could not set up the addon");
    return exports;
  }

  static const struct {
    const char *name;
    napi_callback fn;
  } functions[] = {
    {"connect", fn_connect},
    {"query", fn_query},
    {"bulkBegin", fn_bulk_begin},
    {"bulkSend", fn_bulk_send},
    {"close", fn_close},
    {"isAlive", fn_is_alive},
    {"serverCharset", fn_server_charset},
    {"getVersion", fn_get_version},
  };
  for (size_t i = 0; i < sizeof(functions) / sizeof(functions[0]); i++) {
    napi_value fn;
    if (napi_create_function(env, functions[i].name, NAPI_AUTO_LENGTH, functions[i].fn, NULL, &fn) !=
            napi_ok ||
        napi_set_named_property(env, exports, functions[i].name, fn) != napi_ok) {
      return fail_call(env, "drizzle-sybase: could not set up the addon");
    }
  }

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
