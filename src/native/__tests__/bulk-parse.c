/*
 * Checks of the bulk copy value parsers (binding.c): every value they accept
 * converts exactly, and every value they refuse is refused. Money and numeric
 * are checked by round trip through format_exact_numeric — itself checked
 * against dbconvert by exact-numeric-format.c — and datetime against db-lib's
 * own date cracking. Built and run by bulk-parse.test.ts.
 */
#include "binding.c"

#include <locale.h>

static uint64_t rng_state = 0x2545f4914f6cdd1dULL;
static uint64_t rnd(void) {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 7;
  rng_state ^= rng_state << 17;
  return rng_state;
}

static long failures = 0;
static long checks = 0;

#define REPORT(...)                       \
  do {                                  \
    if (failures++ < 30) {              \
      fprintf(stderr, __VA_ARGS__);     \
      fputc('\n', stderr);              \
    }                                   \
  } while (0)

static BulkColumn column(int type, int precision, int scale) {
  BulkColumn col;
  memset(&col, 0, sizeof(col));
  col.type = type;
  col.precision = precision;
  col.scale = scale;
  bulk_classify(&col);
  return col;
}

/** Parse `text` as money and expect `units` (or a refusal when `ok` is 0). */
static void expect_money(const BulkColumn *col, const char *text, int ok, int64_t units) {
  DBMONEY m;
  const char *why = NULL;
  int rc = parse_bulk_money(text, col, &m, &why);
  checks++;
  if ((rc == 0) != ok) {
    REPORT("money '%s': expected %s, got %s", text, ok ? "accepted" : "refused", why ? why : "accepted");
    return;
  }
  if (ok) {
    int64_t got = (int64_t)(((uint64_t)(uint32_t)m.mnyhigh << 32) | m.mnylow);
    if (got != units) {
      REPORT("money '%s': got %lld units, expected %lld", text, (long long)got, (long long)units);
    }
  }
}

static void check_money(void) {
  BulkColumn money = column(SYBMONEY, 0, 0), small = column(SYBMONEY4, 0, 0);
  // Every value round-trips through the text db-lib (and the driver) renders.
  for (long i = 0; i < 2000000; i++) {
    int64_t units = (int64_t)rnd() >> (rnd() % 64);
    DBMONEY m = {(DBINT)(units >> 32), (DBUINT)(uint32_t)units};
    char text[128];
    int len = format_exact_numeric(SYBMONEY, (const BYTE *)&m, sizeof(m), text);
    text[len] = '\0';
    expect_money(&money, text, 1, units);
  }
  expect_money(&money, "922337203685477.5807", 1, INT64_MAX);
  expect_money(&money, "-922337203685477.5808", 1, INT64_MIN);
  expect_money(&money, "922337203685477.5808", 0, 0);
  expect_money(&money, "-922337203685477.5809", 0, 0);
  expect_money(&money, "1000000000000000", 0, 0);
  expect_money(&money, "12.3456", 1, 123456);
  expect_money(&money, "+12.3", 1, 123000);
  expect_money(&money, "0012.30000000", 1, 123000);  // zeros change nothing
  expect_money(&money, ".5", 1, 5000);
  expect_money(&money, "5.", 1, 50000);
  expect_money(&money, "-0", 1, 0);
  expect_money(&money, "12.34567", 0, 0);  // never rounded
  expect_money(&money, "12.34561", 0, 0);
  for (const char *const *bad = (const char *const[]){"", "-", ".", "1e3", "1,5", " 1", "1 ", "--1",
                                                      "0x10", "1.2.3", "NaN", NULL};
       *bad; bad++) {
    expect_money(&money, *bad, 0, 0);
  }
  expect_money(&small, "214748.3647", 1, INT32_MAX);
  expect_money(&small, "-214748.3648", 1, INT32_MIN);
  expect_money(&small, "214748.3648", 0, 0);
  expect_money(&small, "-214748.3649", 0, 0);
}

static void check_numeric(void) {
  for (long i = 0; i < 1000000; i++) {
    int precision = 1 + (int)(rnd() % 38);
    int scale = (int)(rnd() % (unsigned)(precision + 1));
    BulkColumn col = column(SYBNUMERIC, precision, scale);
    // Random digits that fit, rendered the way the driver reads numeric back.
    char digits[80];
    int int_len = (int)(rnd() % (unsigned)(precision - scale + 1));
    int n = 0;
    if (rnd() % 2) {
      digits[n++] = '-';
    }
    for (int k = 0; k < int_len; k++) {
      digits[n++] = (char)('0' + rnd() % 10);
    }
    if (int_len == 0) {
      digits[n++] = '0';
    }
    if (scale > 0) {
      digits[n++] = '.';
      for (int k = 0; k < scale; k++) {
        digits[n++] = (char)('0' + rnd() % 10);
      }
    }
    digits[n] = '\0';
    DBNUMERIC num;
    const char *why = NULL;
    checks++;
    if (parse_bulk_numeric(digits, &col, &num, &why) != 0) {
      REPORT("numeric(%d,%d) '%s' refused: %s", precision, scale, digits, why);
      continue;
    }
    char back[128];
    int len = write_numeric(back, &num);
    back[len > 0 ? len : 0] = '\0';
    // Equal as numbers: the text read back drops leading zeros and "-0".
    char *a = digits[0] == '-' ? digits + 1 : digits, *b = back[0] == '-' ? back + 1 : back;
    while (a[0] == '0' && a[1] != '\0' && a[1] != '.') {
      a++;
    }
    int a_zero = strspn(a, "0.") == strlen(a);
    int same_sign = (digits[0] == '-') == (back[0] == '-') || a_zero;
    if (strcmp(a, b) != 0 || !same_sign) {
      REPORT("numeric(%d,%d) '%s' read back as '%s'", precision, scale, digits, back);
    }
    // One digit too many, before or after the point, is refused.
    if (precision - scale < 38 && int_len == precision - scale && int_len > 0) {
      char wider[90];
      snprintf(wider, sizeof(wider), "9%s", digits[0] == '-' ? digits + 1 : digits);
      checks++;
      if (parse_bulk_numeric(wider, &col, &num, &why) == 0) {
        REPORT("numeric(%d,%d) '%s' accepted", precision, scale, wider);
      }
    }
    if (scale > 0) {
      char longer[90];
      snprintf(longer, sizeof(longer), "%s%s1", digits, scale > 0 ? "" : ".");
      checks++;
      if (parse_bulk_numeric(longer, &col, &num, &why) == 0) {
        REPORT("numeric(%d,%d) '%s' accepted (would be rounded)", precision, scale, longer);
      }
    }
  }
  BulkColumn n194 = column(SYBNUMERIC, 19, 4);
  DBNUMERIC num;
  const char *why;
  checks++;
  if (parse_bulk_numeric("12.345600", &n194, &num, &why) != 0) {
    REPORT("numeric(19,4) refused trailing zeros past its scale");
  }
}

/** db-lib's own view of a datetime: the fields dbdatecrack reports. */
static void check_datetime_value(const char *text, int ok, const char *expect) {
  DBDATETIME dt;
  const char *why = NULL;
  int rc = parse_bulk_datetime(text, &dt, &why);
  checks++;
  if ((rc == 0) != ok) {
    REPORT("datetime '%s': expected %s, got %s", text, ok ? "accepted" : "refused", why ? why : "accepted");
    return;
  }
  if (!ok) {
    return;
  }
  char back[64];
  int len = format_temporal_value(NULL, SYBDATETIME, &dt, back, sizeof(back));
  back[len > 0 ? len : 0] = '\0';
  if (strcmp(back, expect) != 0) {
    REPORT("datetime '%s' stored as '%s', expected '%s'", text, back, expect);
  }
}

static void check_datetime(void) {
  // Whole 1/100 s are exact ticks (3 per 10 ms): they read back unchanged.
  for (long i = 0; i < 300000; i++) {
    int year = 1753 + (int)(rnd() % (9999 - 1753 + 1));
    int month = 1 + (int)(rnd() % 12);
    int day = 1 + (int)(rnd() % (unsigned)days_in_month(year, month));
    int hour = (int)(rnd() % 24), minute = (int)(rnd() % 60), second = (int)(rnd() % 60);
    int ms = (int)(rnd() % 100) * 10;
    char text[64];
    snprintf(text, sizeof(text), "%04d-%02d-%02d %02d:%02d:%02d.%03d", year, month, day, hour, minute,
             second, ms);
    check_datetime_value(text, 1, text);
  }
  check_datetime_value("2024-02-29 01:02:03.456", 1, "2024-02-29 01:02:03.457");
  check_datetime_value("2024-03-04 10:00:00.999", 1, "2024-03-04 10:00:00.997");  // never the next second
  check_datetime_value("2024-03-04 23:59:59.999", 1, "2024-03-04 23:59:59.997");
  check_datetime_value("2024-03-04 10:00:00.002", 1, "2024-03-04 10:00:00.003");
  check_datetime_value("2024-03-04 10:00:00.001", 1, "2024-03-04 10:00:00.000");
  check_datetime_value("2024-03-04 10:00:00.5", 1, "2024-03-04 10:00:00.500");
  check_datetime_value("2024-03-04T10:00", 1, "2024-03-04 10:00:00.000");
  check_datetime_value("2024-03-04", 1, "2024-03-04 00:00:00.000");
  check_datetime_value("1753-01-01 00:00:00.000", 1, "1753-01-01 00:00:00.000");
  check_datetime_value("9999-12-31 23:59:59.998", 1, "9999-12-31 23:59:59.997");
  for (const char *const *bad = (const char *const[]){
           "1752-12-31 23:59:59", "2023-02-29", "2024-13-01", "2024-00-10", "2024-04-31",
           "2024-01-01 24:00", "2024-01-01 10:60", "2024-01-01 10:00:60", "2024-01-01 10:00:00.",
           "2024-01-01 10:00:00.1234", "2024-1-01", "24-01-01", "2024/01/01", "2024-01-01 10",
           "2024-01-01 10:00:0", " 2024-01-01", "2024-01-01 ", "", NULL};
       *bad; bad++) {
    check_datetime_value(*bad, 0, NULL);
  }
}

static void check_smalldatetime_value(const char *text, int ok, int days, int minutes) {
  DBDATETIME4 dt;
  const char *why = NULL;
  int rc = parse_bulk_smalldatetime(text, &dt, &why);
  checks++;
  if ((rc == 0) != ok) {
    REPORT("smalldatetime '%s': expected %s, got %s", text, ok ? "accepted" : "refused",
         why ? why : "accepted");
  } else if (ok && (dt.days != days || dt.minutes != minutes)) {
    REPORT("smalldatetime '%s': got day %d minute %d, expected %d %d", text, dt.days, dt.minutes, days,
         minutes);
  }
}

static void check_smalldatetime(void) {
  // As ASE converts a literal (checked against ASE 15.7): 30 s and up round up.
  check_smalldatetime_value("1900-01-01 00:00:00", 1, 0, 0);
  check_smalldatetime_value("1900-01-01 00:00:29.999", 1, 0, 0);
  check_smalldatetime_value("1900-01-01 00:00:30.000", 1, 0, 1);
  check_smalldatetime_value("1900-01-01 23:59:30", 1, 1, 0);
  check_smalldatetime_value("2079-06-06 23:59:29.999", 1, 65535, 1439);
  check_smalldatetime_value("2079-06-06 23:59:30", 0, 0, 0);
  check_smalldatetime_value("1899-12-31 23:59:59", 0, 0, 0);  // not rounded into range
  check_smalldatetime_value("1899-12-31 23:59:29", 0, 0, 0);
}

static void expect_int(const BulkColumn *col, const char *text, int ok, int64_t value) {
  int64_t v = 0;
  int rc = parse_bulk_int(text, col->min, col->max, &v);
  checks++;
  if ((rc == 0) != ok || (ok && v != value)) {
    REPORT("%s '%s': rc %d value %lld", syb_type_name(col->type), text, rc, (long long)v);
  }
}

static void check_ints(void) {
  BulkColumn tiny = column(SYBINT1, 0, 0), small = column(SYBINT2, 0, 0), i4 = column(SYBINT4, 0, 0),
             big = column(SYBINT8, 0, 0);
  expect_int(&tiny, "0", 1, 0);
  expect_int(&tiny, "255", 1, 255);
  expect_int(&tiny, "256", 0, 0);
  expect_int(&tiny, "-1", 0, 0);
  expect_int(&small, "-32768", 1, -32768);
  expect_int(&small, "32768", 0, 0);
  expect_int(&i4, "2147483647", 1, INT32_MAX);
  expect_int(&i4, "-2147483649", 0, 0);
  expect_int(&i4, "+7", 1, 7);
  expect_int(&big, "9223372036854775807", 1, INT64_MAX);
  expect_int(&big, "-9223372036854775808", 1, INT64_MIN);
  expect_int(&big, "9223372036854775808", 0, 0);
  expect_int(&big, "-9223372036854775809", 0, 0);
  expect_int(&big, "99999999999999999999999", 0, 0);
  for (const char *const *bad = (const char *const[]){"", "-", "1.0", "1e3", " 1", "0x1", NULL};
       *bad; bad++) {
    expect_int(&i4, *bad, 0, 0);
  }
}

static void check_floats(void) {
  double v;
  const char *why;
  const char *good[] = {"0", "-1.5", "1e10", "1E-5", ".5", "5.", "+3.25", "1.7976931348623157e308"};
  for (size_t i = 0; i < sizeof(good) / sizeof(good[0]); i++) {
    checks++;
    if (parse_bulk_float(good[i], 0, &v, &why) != 0 || v != strtod(good[i], NULL)) {
      REPORT("float '%s' refused or misread", good[i]);
    }
  }
  const char *bad[] = {"", "e5", "1e", "1e+", "inf", "nan", "1,5", "0x1p3", "1e400", "1.5 "};
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
    checks++;
    if (parse_bulk_float(bad[i], 0, &v, &why) == 0) {
      REPORT("float '%s' accepted", bad[i]);
    }
  }
  checks++;
  if (parse_bulk_float("1e39", 1, &v, &why) == 0) {
    REPORT("real '1e39' accepted");
  }
  // Under a locale with a decimal comma strtod stops at the '.': the value
  // must be refused, not read as 1.
  if (setlocale(LC_NUMERIC, "de_DE.UTF-8") || setlocale(LC_NUMERIC, "de_DE")) {
    checks++;
    if (parse_bulk_float("1.5", 0, &v, &why) == 0 && v != 1.5) {
      REPORT("float '1.5' misread as %g under a decimal-comma locale", v);
    }
    setlocale(LC_NUMERIC, "C");
  }
}

/** Encode `field` as text for the server and compare with `expect` (NULL: refused, with `why` containing `reason`). */
static void expect_text(BulkState *st, const BulkField *f, int latin1, const char *expect, size_t expect_len,
                        const char *reason) {
  char why[256] = "";
  long n = bulk_encode_text(st, f, latin1, why, sizeof(why));
  checks++;
  if (!expect) {
    if (n >= 0 || !strstr(why, reason)) {
      REPORT("text expected refused (%s), got %ld '%s'", reason, n, why);
    }
    return;
  }
  if (n != (long)expect_len || memcmp(st->text, expect, expect_len) != 0) {
    REPORT("text encoded to %ld bytes, expected %zu (%s)", n, expect_len, why);
  }
}

static void check_text(void) {
  BulkState st;
  memset(&st, 0, sizeof(st));
  const uint16_t e_acute[] = {'c', 0xE9, 'a'};
  const uint16_t han[] = {'a', 0x4E2D};
  const uint16_t emoji[] = {0xD83D, 0xDE00};
  const uint16_t lone[] = {'x', 0xDC00};
  BulkField f;
  memset(&f, 0, sizeof(f));

  f.units = e_acute, f.length = 3;
  expect_text(&st, &f, 1, "c\xE9" "a", 3, NULL);
  expect_text(&st, &f, 0, "c\xC3\xA9" "a", 4, NULL);
  f.units = han, f.length = 2;
  expect_text(&st, &f, 1, NULL, 0, "U+4E2D at character 2");
  expect_text(&st, &f, 0, "a\xE4\xB8\xAD", 4, NULL);
  f.units = emoji, f.length = 2;
  expect_text(&st, &f, 1, NULL, 0, "U+1F600 at character 1");
  expect_text(&st, &f, 0, "\xF0\x9F\x98\x80", 4, NULL);
  f.units = lone, f.length = 2;
  expect_text(&st, &f, 0, NULL, 0, "unpaired surrogate at character 2");

  f.units = NULL;
  f.bytes = (const unsigned char *)"c\xC3\xA9" "a", f.length = 4;
  expect_text(&st, &f, 1, "c\xE9" "a", 3, NULL);
  expect_text(&st, &f, 0, "c\xC3\xA9" "a", 4, NULL);
  f.bytes = (const unsigned char *)"\xE4\xB8\xAD", f.length = 3;
  expect_text(&st, &f, 1, NULL, 0, "U+4E2D at character 1");
  f.bytes = (const unsigned char *)"ab\xE9", f.length = 3;  // Latin-1, not UTF-8
  expect_text(&st, &f, 1, NULL, 0, "not valid UTF-8 (at character 3)");
  f.bytes = (const unsigned char *)"\xC0\xAF", f.length = 2;  // overlong
  expect_text(&st, &f, 0, NULL, 0, "not valid UTF-8");
  f.bytes = (const unsigned char *)"\xED\xA0\x80", f.length = 3;  // a surrogate in UTF-8
  expect_text(&st, &f, 0, NULL, 0, "not valid UTF-8");
  f.bytes = (const unsigned char *)"a\0b", f.length = 3;  // TSV bytes
  expect_text(&st, &f, 0, NULL, 0, "NUL character at character 2");
  f.bytes = NULL;
  const uint16_t nul[] = {0};
  f.units = nul, f.length = 1;
  expect_text(&st, &f, 1, NULL, 0, "NUL character at character 1");
  free(st.text);
}

int main(void) {
  dbinit();
  check_money();
  check_numeric();
  check_datetime();
  check_smalldatetime();
  check_ints();
  check_floats();
  check_text();
  printf("%ld checks, %ld failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
