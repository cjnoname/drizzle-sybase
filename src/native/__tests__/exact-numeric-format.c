/*
 * Differential check of format_exact_numeric (binding.c) against db-lib's own
 * dbconvert: every money, smallmoney and numeric value must render byte for
 * byte the same. Also checks that format_double writes `.` as the decimal point
 * under a locale with a decimal comma. Built and run by exact-numeric-format.test.ts.
 */
#include "binding.c"

#include <locale.h>

static uint64_t rng_state = 0x9e3779b97f4a7c15ULL;
static uint64_t rnd(void) {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 7;
  rng_state ^= rng_state << 17;
  return rng_state;
}

static long failures = 0;

static void check(int type, const void *src, int len, const char *label) {
  char mine[128], theirs[128];
  int a = format_exact_numeric(type, (const BYTE *)src, len, mine);
  int b = dbconvert(NULL, type, (const BYTE *)src, len, SYBCHAR, (BYTE *)theirs, 127);
  if (a < 0 || b < 0 || a != b || memcmp(mine, theirs, (size_t)a) != 0) {
    if (failures++ < 20) {
      fprintf(stderr, "%s MISMATCH mine=%d[%.*s] dbconvert=%d[%.*s]\n", label, a, a > 0 ? a : 0, mine,
              b, b > 0 ? b : 0, theirs);
    }
  }
}

int main(void) {
  dbinit();
  long n = 0;
  // money: edges, then random 64-bit values of every magnitude
  int64_t edges[] = {0, 1, -1, 9999, -9999, 10000, -10000, INT64_MAX, INT64_MIN, INT64_MIN + 1};
  for (size_t i = 0; i < sizeof(edges) / sizeof(edges[0]); i++) {
    DBMONEY m = {(DBINT)(edges[i] >> 32), (DBUINT)(uint32_t)edges[i]};
    check(SYBMONEY, &m, sizeof(m), "money");
    n++;
  }
  for (long i = 0; i < 4000000; i++) {
    uint64_t v = rnd() >> (rnd() % 64);
    if (rnd() & 1) v = 0 - v;
    DBMONEY m = {(DBINT)(uint32_t)(v >> 32), (DBUINT)(uint32_t)v};
    check(SYBMONEY, &m, sizeof(m), "money");
    n++;
  }
  // smallmoney: edges and random
  int32_t edges4[] = {0, 1, -1, 9999, -10000, INT32_MAX, INT32_MIN};
  for (size_t i = 0; i < sizeof(edges4) / sizeof(edges4[0]); i++) {
    DBMONEY4 m = {edges4[i]};
    check(SYBMONEY4, &m, sizeof(m), "smallmoney");
    n++;
  }
  for (long i = 0; i < 2000000; i++) {
    DBMONEY4 m = {(DBINT)(uint32_t)(rnd() >> (rnd() % 64))};
    if (rnd() & 1) m.mny4 = -m.mny4;
    check(SYBMONEY4, &m, sizeof(m), "smallmoney");
    n++;
  }
  // numeric/decimal: every precision and scale, magnitudes from zero to full width
  for (int p = 1; p <= 77; p++) {
    for (int s = 0; s <= p; s++) {
      for (int k = 0; k < 1500; k++) {
        DBNUMERIC num;
        memset(&num, 0, sizeof(num));
        num.precision = (unsigned char)p;
        num.scale = (unsigned char)s;
        num.array[0] = (unsigned char)(rnd() & 1);
        int bytes = NUMERIC_BYTES[p] - 1;
        int used = k == 0 ? 0 : (int)(rnd() % (unsigned)(bytes + 1));
        for (int b = bytes - used; b < bytes; b++) {
          num.array[1 + b] = (unsigned char)rnd();
        }
        check(SYBNUMERIC, &num, sizeof(num), "numeric");
        check(SYBDECIMAL, &num, sizeof(num), "decimal");
        n += 2;
      }
    }
  }
  // A decimal-comma locale, where one is installed: the CSV writer must not
  // emit "0,5", which reads as two fields.
  const char *comma_locales[] = {"de_DE.UTF-8", "de_DE.utf8", "fr_FR.UTF-8", "fr_FR.utf8", "de_DE"};
  for (size_t i = 0; i < sizeof(comma_locales) / sizeof(comma_locales[0]); i++) {
    if (setlocale(LC_NUMERIC, comma_locales[i]) && localeconv()->decimal_point[0] == ',') {
      double samples[] = {0.5, -1.25, 0.1 + 0.2, 1e-300, 123456.789};
      for (size_t k = 0; k < sizeof(samples) / sizeof(samples[0]); k++) {
        char buf[40];
        int len = format_double(samples[k], buf, sizeof(buf));
        setlocale(LC_NUMERIC, "C");
        if (memchr(buf, ',', (size_t)len) || strtod(buf, NULL) != samples[k]) {
          if (failures++ < 20) {
            fprintf(stderr, "format_double under %s wrote [%.*s]\n", comma_locales[i], len, buf);
          }
        }
        setlocale(LC_NUMERIC, comma_locales[i]);
        n++;
      }
      setlocale(LC_NUMERIC, "C");
      printf("decimal-comma locale %s checked\n", comma_locales[i]);
      break;
    }
  }
  printf("checked %ld values, %ld mismatches\n", n, failures);
  return failures != 0;
}
