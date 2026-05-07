/**
 * FreeTDS db-lib N-API native addon — production-grade implementation.
 *
 * Improvements over initial version:
 * - #1: Error messages from Sybase server are captured per-connection and
 *       passed back to JS (not just fprintf to stderr)
 * - #4: Memory cleanup on all error paths (no leaks)
 * - #5: maxRows protection to prevent OOM on large result sets
 * - #6: Query timeout support via DBSETTIME
 * - #9: Correct affectedRows for all DML result sets (accumulates across batch)
 * - Dead connection detection via DBDEAD()
 *
 * All I/O is done on libuv worker threads (napi_create_async_work)
 * so the event loop is never blocked.
 */
#include <node_api.h>
#include <sybfront.h>
#include <sybdb.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

// ---------------------------------------------------------------------------
// Per-connection error buffer
// ---------------------------------------------------------------------------

// Maximum error message size we'll capture
#define ERR_BUF_SIZE 4096
// Maximum rows to return by default (safety limit)
#define DEFAULT_MAX_ROWS 1000000

/**
 * Connection wrapper — holds the DBPROCESS plus error state.
 *
 * Error/message handlers use dbgetuserdata() to find this struct
 * and write error text into it. The query function checks has_error
 * after each db-lib call.
 */
typedef struct {
  DBPROCESS *dbproc;
  LOGINREC *login;
  char last_error[ERR_BUF_SIZE];
  int has_error;
  int dead;  // set by err_handler if connection is dead
} SybaseConnection;

// ---------------------------------------------------------------------------
// Error/message handlers — store errors in connection's buffer
// ---------------------------------------------------------------------------

static int err_handler(DBPROCESS *dbproc, int severity, int dberr,
                       int oserr, char *dberrstr, char *oserrstr) {
  (void)oserr;
  (void)oserrstr;

  SybaseConnection *conn = NULL;
  if (dbproc) {
    conn = (SybaseConnection *)dbgetuserdata(dbproc);
  }

  if (conn) {
    // Append to error buffer
    size_t cur_len = strlen(conn->last_error);
    if (cur_len < ERR_BUF_SIZE - 100) {
      snprintf(conn->last_error + cur_len, ERR_BUF_SIZE - cur_len,
               "DB-Lib error %d (severity %d): %s\n", dberr, severity, dberrstr);
    }
    conn->has_error = 1;

    // Check if connection is dead
    if (DBDEAD(dbproc)) {
      conn->dead = 1;
    }
  }

  // Return INT_CANCEL for fatal errors, INT_CONTINUE for timeouts
  if (dberr == SYBETIME) {
    // Timeout — cancel the query
    return INT_CANCEL;
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
// Helper: clear connection error state before operations
// ---------------------------------------------------------------------------

static void clear_error(SybaseConnection *conn) {
  conn->last_error[0] = '\0';
  conn->has_error = 0;
}

// ---------------------------------------------------------------------------
// Helper: free query result columns (used in both success and error paths)
// ---------------------------------------------------------------------------

typedef struct {
  char *name;
  char **values;
  int type;
} ResultColumn;

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

  w->conn->login = dblogin();
  if (!w->conn->login) {
    snprintf(w->error, sizeof(w->error), "dblogin() failed");
    w->success = 0;
    free(w->conn);
    w->conn = NULL;
    return;
  }

  DBSETLUSER(w->conn->login, w->username);
  DBSETLPWD(w->conn->login, w->password);
  DBSETLAPP(w->conn->login, "drizzle-sybase");

  // Set TDS version to 5.0 (Sybase ASE native)
  DBSETLVERSION(w->conn->login, DBVERSION_100);

  // Set login timeout
  if (w->timeout_seconds > 0) {
    dbsetlogintime(w->timeout_seconds);
  }

  // Build host:port string
  char server[300];
  snprintf(server, sizeof(server), "%s:%d", w->host, w->port);

  w->conn->dbproc = dbopen(w->conn->login, server);
  if (!w->conn->dbproc) {
    snprintf(w->error, sizeof(w->error), "Failed to connect to %s:%d",
             w->host, w->port);
    dbloginfree(w->conn->login);
    free(w->conn);
    w->conn = NULL;
    w->success = 0;
    return;
  }

  // Associate our connection struct with the DBPROCESS for error handlers
  dbsetuserdata(w->conn->dbproc, (BYTE *)w->conn);

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
      free(w->conn);
      w->conn = NULL;
      w->success = 0;
      return;
    }
  }

  // Set query timeout if specified
  if (w->timeout_seconds > 0) {
    dbsettime(w->timeout_seconds);
  }

  w->success = 1;
}

static void connect_complete(napi_env env, napi_status status, void *data) {
  ConnectWork *w = (ConnectWork *)data;

  if (status == napi_cancelled || !w->success) {
    napi_value error_msg, error_obj;
    napi_create_string_utf8(env, w->error, NAPI_AUTO_LENGTH, &error_msg);
    napi_create_error(env, NULL, error_msg, &error_obj);
    napi_reject_deferred(env, w->deferred, error_obj);
  } else {
    napi_value result;
    napi_create_external(env, w->conn, NULL, NULL, &result);
    napi_resolve_deferred(env, w->deferred, result);
  }

  napi_delete_async_work(env, w->work);
  free(w);
}

// napi_value connect(config: { host, port, database, username, password, timeout? })
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

  // Optional timeout (seconds)
  w->timeout_seconds = 30; // default 30s
  napi_get_named_property(env, args[0], "timeout", &val);
  napi_typeof(env, val, &vtype);
  if (vtype == napi_number) {
    napi_get_value_int32(env, val, &w->timeout_seconds);
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
// Async work: query
// ---------------------------------------------------------------------------

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  SybaseConnection *conn;
  char *sql;
  int max_rows;
  // Results
  ResultColumn *columns;
  int num_columns;
  int num_rows;
  int affected_rows;
  char error[ERR_BUF_SIZE];
  int success;
} QueryWork;

static void query_execute(napi_env env, void *data) {
  (void)env;
  QueryWork *w = (QueryWork *)data;

  if (!w->conn || !w->conn->dbproc) {
    snprintf(w->error, sizeof(w->error), "Connection is closed");
    w->success = 0;
    return;
  }

  // Check if connection is dead
  if (w->conn->dead || DBDEAD(w->conn->dbproc)) {
    snprintf(w->error, sizeof(w->error), "Connection is dead");
    w->conn->dead = 1;
    w->success = 0;
    return;
  }

  // Clear error state before executing
  clear_error(w->conn);

  // Send SQL command
  if (dbcmd(w->conn->dbproc, w->sql) == FAIL) {
    if (w->conn->has_error) {
      snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
    } else {
      snprintf(w->error, sizeof(w->error), "dbcmd() failed");
    }
    w->success = 0;
    return;
  }

  // Execute
  if (dbsqlexec(w->conn->dbproc) == FAIL) {
    if (w->conn->has_error) {
      snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
    } else {
      snprintf(w->error, sizeof(w->error), "dbsqlexec() failed");
    }
    // Try to cancel any pending state
    dbcancel(w->conn->dbproc);
    w->success = 0;
    return;
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
      free_columns(w->columns, w->num_columns, w->num_rows);
      w->columns = NULL;
      w->num_columns = 0;
      w->num_rows = 0;
      w->success = 0;
      return;
    }

    int ncols = dbnumcols(w->conn->dbproc);

    if (ncols <= 0) {
      // DML or SET — accumulate affected counts
      int cnt = DBCOUNT(w->conn->dbproc);
      if (cnt > 0) {
        w->affected_rows += cnt;
      }
      while (dbnextrow(w->conn->dbproc) != NO_MORE_ROWS) {}
      continue;
    }

    // If we already found a result set, skip subsequent ones
    // (we return the FIRST result set with columns)
    if (found_resultset) {
      while (dbnextrow(w->conn->dbproc) != NO_MORE_ROWS) {}
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
      return;
    }

    for (int i = 0; i < w->num_columns; i++) {
      const char *colname = dbcolname(w->conn->dbproc, i + 1);
      w->columns[i].name = strdup(colname ? colname : "");
      w->columns[i].type = dbcoltype(w->conn->dbproc, i + 1);
      w->columns[i].values = NULL;
    }

    // Read rows
    int capacity = 64;
    w->num_rows = 0;
    int max_rows = w->max_rows > 0 ? w->max_rows : DEFAULT_MAX_ROWS;

    for (int i = 0; i < w->num_columns; i++) {
      w->columns[i].values = (char **)calloc(capacity, sizeof(char *));
      if (!w->columns[i].values) {
        snprintf(w->error, sizeof(w->error), "Memory allocation failed for rows");
        free_columns(w->columns, w->num_columns, w->num_rows);
        w->columns = NULL;
        w->num_columns = 0;
        w->num_rows = 0;
        dbcancel(w->conn->dbproc);
        w->success = 0;
        return;
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
        return;
      }

      // BUF_FULL (row_code > 0 for computed rows) — skip
      if (row_code != REG_ROW) {
        continue;
      }

      // Safety: cap rows
      if (w->num_rows >= max_rows) {
        // Drain remaining rows without storing
        while (dbnextrow(w->conn->dbproc) != NO_MORE_ROWS) {}
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
            return;
          }
          w->columns[i].values = new_vals;
        }
      }

      // Read column values
      for (int i = 0; i < w->num_columns; i++) {
        int col = i + 1;
        int datalen = dbdatlen(w->conn->dbproc, col);

        if (datalen == 0 && dbdata(w->conn->dbproc, col) == NULL) {
          w->columns[i].values[w->num_rows] = NULL;
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
            free_columns(w->columns, w->num_columns, w->num_rows);
            w->columns = NULL;
            w->num_columns = 0;
            w->num_rows = 0;
            dbcancel(w->conn->dbproc);
            w->success = 0;
            return;
          }

          int convlen = dbconvert(w->conn->dbproc, coltype, src, datalen,
                                  SYBCHAR, (BYTE *)buf, buf_size - 1);
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

  // Check if any error occurred during result processing
  if (w->conn->has_error && !found_resultset && w->affected_rows == 0) {
    snprintf(w->error, sizeof(w->error), "%s", w->conn->last_error);
    free_columns(w->columns, w->num_columns, w->num_rows);
    w->columns = NULL;
    w->num_columns = 0;
    w->num_rows = 0;
    w->success = 0;
    return;
  }

  w->success = 1;
}

static void query_complete(napi_env env, napi_status status, void *data) {
  QueryWork *w = (QueryWork *)data;

  if (status == napi_cancelled || !w->success) {
    napi_value error_msg, error_obj;
    napi_create_string_utf8(env, w->error, NAPI_AUTO_LENGTH, &error_msg);
    napi_create_error(env, NULL, error_msg, &error_obj);

    // Add 'dead' property if connection is dead
    if (w->conn && w->conn->dead) {
      napi_value dead_val;
      napi_get_boolean(env, true, &dead_val);
      napi_set_named_property(env, error_obj, "connectionDead", dead_val);
    }

    napi_reject_deferred(env, w->deferred, error_obj);
  } else {
    // Build result object
    napi_value result, rows_arr, cols_arr, row_count, affected;

    napi_create_object(env, &result);
    napi_create_array_with_length(env, w->num_rows, &rows_arr);
    napi_create_array_with_length(env, w->num_columns, &cols_arr);

    // Column names array
    for (int i = 0; i < w->num_columns; i++) {
      napi_value col_name;
      napi_create_string_utf8(env, w->columns[i].name, NAPI_AUTO_LENGTH, &col_name);
      napi_set_element(env, cols_arr, i, col_name);
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
        } else {
          int coltype = w->columns[c].type;
          char *strval = w->columns[c].values[r];

          if (coltype == SYBINT1 || coltype == SYBINT2 || coltype == SYBINT4) {
            int intval = atoi(strval);
            napi_create_int32(env, intval, &val);
          } else if (coltype == SYBINT8) {
            long long llval = atoll(strval);
            if (llval >= -2147483648LL && llval <= 2147483647LL) {
              napi_create_int32(env, (int32_t)llval, &val);
            } else {
              napi_create_int64(env, llval, &val);
            }
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

    napi_value key_rows, key_cols, key_rc, key_aff;
    napi_create_string_utf8(env, "rows", NAPI_AUTO_LENGTH, &key_rows);
    napi_create_string_utf8(env, "columns", NAPI_AUTO_LENGTH, &key_cols);
    napi_create_string_utf8(env, "rowCount", NAPI_AUTO_LENGTH, &key_rc);
    napi_create_string_utf8(env, "affectedRows", NAPI_AUTO_LENGTH, &key_aff);

    napi_set_property(env, result, key_rows, rows_arr);
    napi_set_property(env, result, key_cols, cols_arr);
    napi_set_property(env, result, key_rc, row_count);
    napi_set_property(env, result, key_aff, affected);

    napi_resolve_deferred(env, w->deferred, result);
  }

  // Cleanup — always runs regardless of success/failure
  free_columns(w->columns, w->num_columns, w->num_rows);
  free(w->sql);
  napi_delete_async_work(env, w->work);
  free(w);
}

// napi_value query(conn, sql, options?)
static napi_value fn_query(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  QueryWork *w = (QueryWork *)calloc(1, sizeof(QueryWork));

  // Get connection
  napi_get_value_external(env, args[0], (void **)&w->conn);

  // Get SQL string
  size_t sql_len;
  napi_get_value_string_utf8(env, args[1], NULL, 0, &sql_len);
  w->sql = (char *)malloc(sql_len + 1);
  napi_get_value_string_utf8(env, args[1], w->sql, sql_len + 1, &sql_len);

  // Optional: maxRows from 3rd argument (options object)
  w->max_rows = DEFAULT_MAX_ROWS;
  if (argc >= 3) {
    napi_valuetype vtype;
    napi_typeof(env, args[2], &vtype);
    if (vtype == napi_object) {
      napi_value max_rows_val;
      napi_get_named_property(env, args[2], "maxRows", &max_rows_val);
      napi_typeof(env, max_rows_val, &vtype);
      if (vtype == napi_number) {
        napi_get_value_int32(env, max_rows_val, &w->max_rows);
      }
    }
  }

  napi_value promise;
  napi_create_promise(env, &w->deferred, &promise);

  napi_value work_name;
  napi_create_string_utf8(env, "sybase_query", NAPI_AUTO_LENGTH, &work_name);
  napi_create_async_work(env, NULL, work_name, query_execute, query_complete, w, &w->work);
  napi_queue_async_work(env, w->work);

  return promise;
}

// ---------------------------------------------------------------------------
// Close connection
// ---------------------------------------------------------------------------

static napi_value fn_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  SybaseConnection *conn;
  napi_get_value_external(env, args[0], (void **)&conn);

  if (conn) {
    if (conn->dbproc) {
      dbclose(conn->dbproc);
      conn->dbproc = NULL;
    }
    if (conn->login) {
      dbloginfree(conn->login);
      conn->login = NULL;
    }
    free(conn);
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

  SybaseConnection *conn;
  napi_get_value_external(env, args[0], (void **)&conn);

  int alive = 0;
  if (conn && conn->dbproc && !conn->dead && !DBDEAD(conn->dbproc)) {
    alive = 1;
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
