/**
 * Sybase `datetime` / `smalldatetime` conversion.
 *
 * ASE stores a naive wall clock in these columns — no offset, no zone. The
 * driver therefore cannot know which instant a stored value means unless it is
 * told which zone the server keeps its clocks in, which is what `timeZone` on
 * the connection config is for. With no `timeZone` configured both directions
 * operate in UTC, which makes reads and writes exact inverses of each other
 * without claiming to know the server's zone.
 *
 * One format is used in both directions: `YYYY-MM-DD HH:MM:SS.mmm`, which ASE
 * accepts in a literal and which the native addon produces for every temporal
 * column (see `format_temporal_value` in `binding.c`). It deliberately does NOT
 * go through db-lib's own text rendering, which is locale-dependent and, in
 * several locales, silently drops the seconds and milliseconds.
 *
 * DST is resolved the way `Temporal`'s `compatible` disambiguation does — see
 * {@link parseSybaseDateTime}.
 */

/**
 * `YYYY-MM-DD HH:MM[:SS[.fff...]]`, the canonical form. Seconds and the
 * fraction are optional and a `T` separator is accepted so that hand-written
 * literals parse too; anything beyond milliseconds is ignored because `Date`
 * cannot hold it.
 */
const CANONICAL_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * The years an ASE `datetime` can hold. Bounding both directions here is what
 * keeps the rest of this module free of proleptic-calendar special cases: no BC
 * eras, no two-digit year remapping, and no risk of sampling outside `Date`'s
 * range while resolving offsets.
 *
 * `smalldatetime` is narrower (1900-01-01 to 2079-06-06); overflowing that stays
 * ASE's job, since the column type is not known here.
 */
const MIN_YEAR = 1753;
const MAX_YEAR = 9999;

/**
 * UTC is the default and needs no zone database, so it takes a path that never
 * touches `Intl` — one `formatToParts` call costs about 3µs, which is otherwise
 * the whole cost of decoding a datetime column.
 */
const UTC = "UTC";

/** `Intl.DateTimeFormat` instances are expensive; one per zone is enough. */
const formatters = new Map<string, Intl.DateTimeFormat>();

const wallClockFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown zone. `resolveTimeZone` relies on that.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/**
 * Validate a configured server zone and fall back to UTC when none is given.
 *
 * Called from every public entry point that accepts a config, so a typo surfaces
 * at setup instead of from the middle of the first query — or, worse, the middle
 * of a transaction, since `Intl` only rejects the zone when it is first used.
 */
export const resolveTimeZone = (timeZone?: string): string => {
  if (timeZone === undefined) {
    return UTC;
  }
  try {
    wallClockFormatter(timeZone);
  } catch {
    throw new Error(
      `Invalid timeZone ${JSON.stringify(timeZone)}. ` +
        `Expected an IANA time zone name such as "Australia/Sydney" or "UTC".`
    );
  }
  return timeZone;
};

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** The wall clock a zone shows at an instant. */
const wallClockAt = (instant: Date, timeZone: string): WallClock => {
  if (timeZone === UTC) {
    return {
      year: instant.getUTCFullYear(),
      month: instant.getUTCMonth() + 1,
      day: instant.getUTCDate(),
      hour: instant.getUTCHours(),
      minute: instant.getUTCMinutes(),
      second: instant.getUTCSeconds(),
      millisecond: instant.getUTCMilliseconds()
    };
  }
  const parts = wallClockFormatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find(p => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // h23 renders midnight as 00, but be defensive: a 24 would push the date.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
    // Milliseconds are the same in every zone; no offset is a fraction of a second.
    millisecond: instant.getUTCMilliseconds()
  };
};

const asUtcMs = (clock: WallClock): number =>
  Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
    clock.millisecond
  );

/**
 * Like {@link asUtcMs}, but rejects a wall clock that does not exist on the
 * calendar instead of letting it roll over.
 *
 * `Date.UTC` happily turns month 13 into next January and 31 February into
 * 3 March, so parsing "2016-13-45 99:99:99" would otherwise yield a
 * plausible-looking 2017-02-17. Comparing the components back is enough to
 * catch every out-of-range field and every impossible day, without a table of
 * month lengths.
 */
const strictUtcMs = (clock: WallClock): number | undefined => {
  if (clock.year < MIN_YEAR || clock.year > MAX_YEAR) {
    return undefined;
  }
  const ms = asUtcMs(clock);
  const d = new Date(ms);
  const roundTrips =
    d.getUTCFullYear() === clock.year &&
    d.getUTCMonth() === clock.month - 1 &&
    d.getUTCDate() === clock.day &&
    d.getUTCHours() === clock.hour &&
    d.getUTCMinutes() === clock.minute &&
    d.getUTCSeconds() === clock.second;
  return roundTrips ? ms : undefined;
};

const pad = (value: number, length = 2): string => String(value).padStart(length, "0");

/**
 * Render an instant as the `YYYY-MM-DD HH:MM:SS.mmm` literal ASE stores, using
 * the wall clock of `timeZone` (UTC by default).
 *
 * Throws if that wall clock falls outside the range an ASE `datetime` can hold.
 * Emitting it anyway would produce a literal the server rejects with an
 * arithmetic-overflow message that says nothing about which value caused it.
 */
export const formatSybaseDateTime = (value: Date, timeZone = UTC): string => {
  if (Number.isNaN(value.getTime())) {
    throw new Error("Cannot format an invalid Date as a Sybase datetime");
  }
  const c = wallClockAt(value, timeZone);
  if (c.year < MIN_YEAR || c.year > MAX_YEAR) {
    throw new Error(
      `${value.toISOString()} is ${pad(c.year, 4)} in ${timeZone}, outside the range a Sybase ` +
        `datetime can hold (${MIN_YEAR}-01-01 to ${MAX_YEAR}-12-31)`
    );
  }
  return (
    `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)} ` +
    `${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}.${pad(c.millisecond, 3)}`
  );
};

/**
 * Parse the canonical `YYYY-MM-DD HH:MM:SS.mmm` form back to an instant,
 * reading the wall clock in `timeZone` (UTC by default). Returns `undefined`
 * for text that is not in that form, so callers can decide whether that is an
 * error — {@link decodeDateTimeColumns} treats it as one.
 *
 * A wall clock that a DST transition repeats cannot be resolved to a single
 * instant: two instants an hour apart share it and the column stores no offset,
 * so this returns the standard-time (later) occurrence. A wall clock the
 * transition skips does not exist at all and is moved forward by the size of
 * the jump. Nothing can do better — the ambiguity is in the stored value.
 */
/** Minutes the zone is ahead of UTC at an instant. */
const offsetMinutesAt = (instant: Date, timeZone: string): number =>
  (asUtcMs(wallClockAt(instant, timeZone)) - instant.getTime()) / MS_PER_MINUTE;

/**
 * The two offsets that bracket a wall clock, sampled a day either side.
 *
 * A day is enough: no zone is further than 16 hours from UTC, so the instant a
 * wall clock denotes is always inside the sampled window, and tzdata has no two
 * transitions within a day of each other. Sampling cannot leave `Date`'s range
 * because the wall clock is bounded to {@link MIN_YEAR}..{@link MAX_YEAR}.
 */
const bracketingOffsets = (wallUtcMs: number, timeZone: string): [number, number] => [
  offsetMinutesAt(new Date(wallUtcMs - MS_PER_DAY), timeZone),
  offsetMinutesAt(new Date(wallUtcMs + MS_PER_DAY), timeZone)
];

/**
 * Offsets bracketing a whole calendar day, keyed by zone and day so every wall
 * clock on that day shares one lookup.
 *
 * Resolving an offset costs an `Intl.DateTimeFormat.formatToParts` call, around
 * 3µs, which dominates decoding a datetime column. Sampling on day boundaries
 * instead of relative to each value is what makes the result cacheable.
 *
 * The window is deliberately wider than {@link bracketingOffsets} — a day either
 * side of the day itself — so that a stable result means no transition can
 * affect any wall clock on it.
 */
const dayBrackets = new Map<string, readonly [number, number]>();

/** Keeps the cache from growing without bound in a long-lived process. */
const MAX_CACHED_DAYS = 4096;

const bracketsForDay = (wallUtcMs: number, timeZone: string): readonly [number, number] => {
  const day = Math.floor(wallUtcMs / MS_PER_DAY);
  const key = `${timeZone}|${day}`;
  let brackets = dayBrackets.get(key);
  if (!brackets) {
    const dayStart = day * MS_PER_DAY;
    brackets = [
      offsetMinutesAt(new Date(dayStart - MS_PER_DAY), timeZone),
      offsetMinutesAt(new Date(dayStart + 2 * MS_PER_DAY), timeZone)
    ] as const;
    if (dayBrackets.size >= MAX_CACHED_DAYS) {
      dayBrackets.clear();
    }
    dayBrackets.set(key, brackets);
  }
  return brackets;
};

/**
 * Every instant whose wall clock in `timeZone` is exactly the one given, in
 * ascending order.
 *
 * Normally one. Two when a backward transition repeats the wall clock, none when
 * a forward transition skips it. Each candidate offset has to be confirmed by
 * reading the offset back at the instant it produces — an offset that is not in
 * effect there describes a wall clock the zone never showed.
 *
 * This mirrors `GetNamedTimeZoneEpochNanoseconds` in the Temporal proposal, so
 * the results agree with `Temporal.PlainDateTime.prototype.toZonedDateTime`.
 */
const possibleInstants = (wallUtcMs: number, timeZone: string): number[] => {
  const [before, after] = bracketingOffsets(wallUtcMs, timeZone);
  const offsets = before === after ? [before] : [before, after];
  return offsets
    .flatMap(offset => {
      const candidate = wallUtcMs - offset * MS_PER_MINUTE;
      return offsetMinutesAt(new Date(candidate), timeZone) === offset ? [candidate] : [];
    })
    .sort((a, b) => a - b);
};

/**
 * Parse the canonical `YYYY-MM-DD HH:MM:SS.mmm` form back to an instant,
 * reading the wall clock in `timeZone` (UTC by default). Returns `undefined`
 * for text that is not in that form, so callers can decide whether that is an
 * error — {@link decodeDateTimeColumns} treats it as one.
 *
 * A stored wall clock does not always denote exactly one instant, because the
 * column holds no offset. Both cases are resolved the way `Temporal`'s
 * `compatible` disambiguation does, which is also what `new Date("YYYY-MM-DDTHH:mm")`
 * does with the process zone:
 *
 * - A wall clock a backward transition **repeats** matches two instants an hour
 *   (or half an hour) apart; the earlier is returned.
 * - A wall clock a forward transition **skips** matches none; it is moved
 *   forward by the size of the jump, which is what the zone's clocks did.
 *
 * Nothing can do better than a fixed rule here: the ambiguity is in the stored
 * value, not in the reading of it.
 */
export const parseSybaseDateTime = (text: string, timeZone = UTC): Date | undefined => {
  const match = CANONICAL_DATETIME.exec(text.trim());
  if (!match) {
    return undefined;
  }

  const wallUtcMs = strictUtcMs({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    // Anything past milliseconds is truncated; `Date` cannot hold it.
    millisecond: Number((match[7] ?? "").padEnd(3, "0").slice(0, 3))
  });
  if (wallUtcMs === undefined) {
    return undefined;
  }

  // UTC has no transitions, so the wall clock is the instant. Taking the general
  // path would give the same answer for three times the cost.
  if (timeZone === UTC) {
    return new Date(wallUtcMs);
  }

  // Fast path for the overwhelming majority of days: if the offset is the same a
  // day before and a day after this whole calendar day, no transition can reach
  // any wall clock on it, so there is exactly one instant and no confirmation
  // call is needed. Verified against Temporal across every IANA zone and every
  // transition in 1970-2040, so a pair of cancelling transitions inside the
  // window — which is what would make this unsound — does not occur in tzdata.
  const [dayBefore, dayAfter] = bracketsForDay(wallUtcMs, timeZone);
  if (dayBefore === dayAfter) {
    return new Date(wallUtcMs - dayBefore * MS_PER_MINUTE);
  }

  const exact = possibleInstants(wallUtcMs, timeZone);
  if (exact.length > 0) {
    // Ambiguous wall clocks resolve to the earlier instant.
    return new Date(exact[0]!);
  }

  // In a gap. Advancing the wall clock by the size of the jump lands on the
  // instant the clocks moved to; take the later reading in the unlikely event
  // that shift is itself ambiguous.
  const [before, after] = bracketingOffsets(wallUtcMs, timeZone);
  const shifted = wallUtcMs + (after - before) * MS_PER_MINUTE;
  const resolved = possibleInstants(shifted, timeZone);
  const instant = new Date(resolved.at(-1) ?? shifted - after * MS_PER_MINUTE);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
};

/**
 * Sybase types that hold a wall-clock timestamp and are decoded to `Date`.
 *
 * `date` and `time` are excluded because neither denotes an instant on its own,
 * and `bigdatetime` / `bigtime` because they carry microseconds that a `Date`
 * would silently truncate. Those four stay as canonical text, which is lossless.
 */
const DATETIME_TYPES: ReadonlySet<string> = new Set(["datetime", "smalldatetime"]);

/**
 * Convert the datetime columns of a result set to `Date`, leaving every other
 * column untouched. Columns are chosen from the result's type metadata, never
 * by sniffing values, so a varchar holding a date is never rewritten.
 *
 * Throws if a datetime column holds text that is not in the canonical form.
 * That text comes from the addon shipped in this same package, so a mismatch
 * means the two halves disagree — returning the raw string instead would hand
 * back a `string` where the schema promises a `Date`, and the failure would
 * surface far away from its cause.
 */
export const decodeDateTimeColumns = <T extends Record<string, unknown>>(
  rows: T[],
  columns: string[],
  columnTypes: string[] | undefined,
  timeZone: string
): T[] => {
  if (rows.length === 0) {
    return rows;
  }
  if (!columnTypes) {
    // Only reachable if the loaded addon predates `columnTypes`. Skipping would
    // hand back raw text for every timestamp, so this fails instead.
    throw new Error(
      "The Sybase native addon did not report column types, so datetime columns " +
        "cannot be decoded. Reinstall drizzle-sybase so the bundled addon matches " +
        "the JS layer."
    );
  }
  const dateTimeColumns = columns.filter((_, i) => DATETIME_TYPES.has(columnTypes[i] ?? ""));
  if (dateTimeColumns.length === 0) {
    return rows;
  }
  // Timestamps repeat heavily in real tables — a batch-loaded audit column is
  // often one value for the whole result — and resolving a zoned wall clock is
  // the expensive part. The instant is cached rather than the `Date`, so rows
  // never share a mutable object.
  const resolved = new Map<string, number>();
  return rows.map(row => {
    const decoded: Record<string, unknown> = { ...row };
    for (const column of dateTimeColumns) {
      const value = decoded[column];
      if (typeof value !== "string") {
        continue;
      }
      let instant = resolved.get(value);
      if (instant === undefined) {
        const parsed = parseSybaseDateTime(value, timeZone);
        if (parsed === undefined) {
          throw new Error(
            `Could not decode datetime column ${JSON.stringify(column)}: expected ` +
              `"YYYY-MM-DD HH:MM:SS.mmm" but the driver returned ${JSON.stringify(value)}. ` +
              "This means the native addon and the JS layer are out of sync — reinstall drizzle-sybase."
          );
        }
        instant = parsed.getTime();
        resolved.set(value, instant);
      }
      decoded[column] = new Date(instant);
    }
    return decoded as T;
  });
};
