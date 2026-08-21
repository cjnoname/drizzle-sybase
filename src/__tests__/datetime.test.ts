/**
 * `datetime` / `smalldatetime` conversion.
 *
 * ASE stores a naive wall clock, so every value crossing the wire has to be
 * interpreted in the zone the server keeps. Expectations below are written as
 * absolute ISO instants and derived from the published Sydney offsets — AEST
 * +10:00, AEDT +11:00, with 2024 DST running from 06 Oct 03:00 to 07 Apr
 * 02:00 — rather than from the implementation, and they hold regardless of the
 * process `TZ`.
 *
 * The wire format is the canonical `YYYY-MM-DD HH:MM:SS.mmm` produced by
 * `format_temporal_value` in `binding.c`; it is deliberately the same string the
 * driver writes, so reads and writes are exact inverses.
 */
import { describe, it, expect } from "vitest";

import {
  decodeDateTimeColumns,
  formatSybaseDateTime,
  parseSybaseDateTime,
  resolveTimeZone
} from "../datetime.js";

const SYDNEY = "Australia/Sydney";

describe("formatSybaseDateTime", () => {
  it.each([
    // AEST winter, +10.
    ["2016-06-08T23:48:46.753Z", "2016-06-09 09:48:46.753"],
    // AEDT summer, +11.
    ["2016-01-06T13:00:00.000Z", "2016-01-07 00:00:00.000"],
    // Midnight must render as 00, never 24.
    ["2024-06-30T14:00:00.000Z", "2024-07-01 00:00:00.000"],
    // The instant DST begins.
    ["2024-10-05T16:00:00.000Z", "2024-10-06 03:00:00.000"],
    // The instant DST ends.
    ["2024-04-06T16:00:00.000Z", "2024-04-07 02:00:00.000"]
  ])("renders %s as the Sydney wall clock %s", (instant, expected) => {
    expect(formatSybaseDateTime(new Date(instant), SYDNEY)).toBe(expected);
  });

  it.each(["2016-06-08T23:48:46.753Z", "2024-01-01T00:00:00.000Z", "1999-12-31T23:59:59.999Z"])(
    "defaults to UTC, matching toISOString for %s",
    instant => {
      const date = new Date(instant);
      expect(formatSybaseDateTime(date)).toBe(date.toISOString().slice(0, 23).replace("T", " "));
    }
  );

  it.each([
    // Both ends of what an ASE datetime can hold.
    ["1753-01-01T00:00:00.000Z", "1753-01-01 00:00:00.000"],
    ["9999-12-31T23:59:59.997Z", "9999-12-31 23:59:59.997"]
  ])("covers the full ASE datetime range (%s)", (instant, expected) => {
    expect(formatSybaseDateTime(new Date(instant), "UTC")).toBe(expected);
  });

  // Emitting an out-of-range literal anyway gets an arithmetic-overflow error
  // from ASE that names neither the column nor the value.
  it.each([
    ["1752-12-31T00:00:00.000Z", "UTC"],
    ["0007-03-04T05:06:07.008Z", "UTC"],
    // In range as an instant, but 10000 on the server's clock.
    ["9999-12-31T23:00:00.000Z", SYDNEY]
  ])("refuses %s in %s, which ASE cannot store", (instant, timeZone) => {
    expect(() => formatSybaseDateTime(new Date(instant), timeZone)).toThrow(
      /outside the range a Sybase datetime can hold/
    );
  });

  it("refuses an invalid Date rather than emitting NaN", () => {
    expect(() => formatSybaseDateTime(new Date("nonsense"))).toThrow(/invalid Date/);
  });
});

describe("parseSybaseDateTime", () => {
  it.each([
    ["2016-06-09 09:48:46.753", "2016-06-08T23:48:46.753Z"],
    // Midnight, AEST.
    ["2024-07-01 00:00:00.000", "2024-06-30T14:00:00.000Z"],
    // Last millisecond ASE can hold in a day, AEDT summer.
    ["2024-12-31 23:59:59.997", "2024-12-31T12:59:59.997Z"],
    // Spring forward: 00:30 is still AEST, 03:00 is already AEDT.
    ["2024-10-06 00:30:00.000", "2024-10-05T14:30:00.000Z"],
    ["2024-10-06 03:00:00.000", "2024-10-05T16:00:00.000Z"]
  ])("reads %s as %s", (text, expected) => {
    expect(parseSybaseDateTime(text, SYDNEY)?.toISOString()).toBe(expected);
  });

  it("defaults to UTC", () => {
    expect(parseSybaseDateTime("2016-06-09 09:48:46.753")?.toISOString()).toBe(
      "2016-06-09T09:48:46.753Z"
    );
  });

  // Tolerated so hand-written literals parse; the driver always sends the full
  // form.
  it.each([
    ["2016-06-09 09:48", "2016-06-09T09:48:00.000Z"],
    ["2016-06-09 09:48:46", "2016-06-09T09:48:46.000Z"],
    ["2016-06-09 09:48:46.7", "2016-06-09T09:48:46.700Z"],
    ["2016-06-09 09:48:46.75", "2016-06-09T09:48:46.750Z"],
    ["2016-06-09T09:48:46.753", "2016-06-09T09:48:46.753Z"],
    ["  2016-06-09 09:48:46.753  ", "2016-06-09T09:48:46.753Z"]
  ])("accepts the shorter form %j", (text, expected) => {
    expect(parseSybaseDateTime(text, "UTC")?.toISOString()).toBe(expected);
  });

  // bigdatetime holds microseconds; a Date cannot, so the extra digits are
  // dropped rather than misread as milliseconds.
  it("truncates below milliseconds", () => {
    expect(parseSybaseDateTime("2016-06-09 09:48:46.753456", "UTC")?.toISOString()).toBe(
      "2016-06-09T09:48:46.753Z"
    );
  });

  it.each([
    "not a date",
    "",
    // db-lib's locale-dependent rendering, which the driver no longer produces.
    "Jun  9 2016 09:48:46:753AM",
    "09/06/2016 09:48",
    "2016-6-9 09:48:46.753",
    "2016-06-09",
    "09:48:46.753",
    "2016-13-45 99:99:99.999",
    // Outside what an ASE datetime can hold, so not a value this can have come
    // from and not one that can be written back.
    "1752-12-31 23:59:59.997",
    "0007-03-04 05:06:07.008"
  ])("returns undefined for unrecognised text (%j)", text => {
    expect(parseSybaseDateTime(text, SYDNEY)).toBeUndefined();
  });

  it.each(["1753-01-01 00:00:00.000", "9999-12-31 23:59:59.997"])(
    "accepts the ends of the ASE datetime range (%s)",
    text => {
      expect(parseSybaseDateTime(text, "UTC")?.toISOString().slice(0, 10)).toBe(text.slice(0, 10));
    }
  );
});

describe("round trip", () => {
  /**
   * `parseSybaseDateTime` and `formatSybaseDateTime` are inverses except where
   * the stored value is genuinely ambiguous, so the property that must hold for
   * every instant is: the wall clock survives, and the instant survives too
   * unless that wall clock occurs twice.
   */
  const assertRoundTrip = (instant: Date, timeZone: string) => {
    const stored = formatSybaseDateTime(instant, timeZone);
    const read = parseSybaseDateTime(stored, timeZone);
    expect(read, `${stored} in ${timeZone} did not parse`).toBeDefined();
    // The wall clock always survives, even when the instant cannot.
    expect(formatSybaseDateTime(read!, timeZone), `${stored} in ${timeZone}`).toBe(stored);
  };

  it.each([
    "2016-06-08T23:48:46.753Z", // AEST
    "2016-01-06T13:00:00.000Z", // AEDT
    "2024-06-30T14:00:00.000Z", // midnight
    "2024-10-05T16:00:00.000Z", // DST starts
    "2024-12-31T12:59:59.997Z", // last ms of the year
    "2024-08-15T02:30:00.000Z", // ordinary winter afternoon
    "1753-01-01T14:00:00.000Z", // earliest ASE datetime
    "9999-12-31T12:59:59.997Z" // latest ASE datetime
  ])("preserves %s through write then read", instant => {
    assertRoundTrip(new Date(instant), SYDNEY);
  });

  // Every hour of a full year in the zones whose transitions are least
  // ordinary: a 30-minute DST shift, a :45 offset, a zone that skipped a whole
  // day, a negative half-hour offset and one with no transitions at all.
  it.each([
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Pacific/Chatham",
    "America/St_Johns",
    "Asia/Kolkata"
  ])("preserves every hour of 2024 in %s", timeZone => {
    const end = Date.UTC(2025, 0, 1);
    for (let ms = Date.UTC(2024, 0, 1); ms < end; ms += 3_600_000) {
      assertRoundTrip(new Date(ms), timeZone);
    }
  });

  it("resolves a wall clock a backward transition repeats to the earlier instant", () => {
    // 02:00-02:59 recurs on the morning DST ends, so two instants an hour apart
    // share one wall clock. The offset is not stored, so nothing can tell them
    // apart afterwards; the earlier one is returned, matching Temporal's
    // `compatible` disambiguation and `new Date("YYYY-MM-DDTHH:mm")`.
    const duringAedt = new Date("2024-04-06T15:59:00.000Z");
    const duringAest = new Date("2024-04-06T16:59:00.000Z");

    expect(formatSybaseDateTime(duringAedt, SYDNEY)).toBe("2024-04-07 02:59:00.000");
    expect(formatSybaseDateTime(duringAest, SYDNEY)).toBe("2024-04-07 02:59:00.000");
    expect(parseSybaseDateTime("2024-04-07 02:59:00.000", SYDNEY)?.toISOString()).toBe(
      duringAedt.toISOString()
    );
  });

  // The mirror image: the hour DST skips has no instant at all, so the wall clock
  // moves forward by the size of the jump — what the zone's clocks did. Only
  // reachable for a value written by something other than this driver, since
  // formatSybaseDateTime never produces a wall clock that does not exist.
  it("moves a wall clock a forward transition skipped forward by the jump", () => {
    expect(parseSybaseDateTime("2024-10-06 02:30:00.000", SYDNEY)?.toISOString()).toBe(
      "2024-10-05T16:30:00.000Z"
    );
    expect(formatSybaseDateTime(new Date("2024-10-05T16:30:00.000Z"), SYDNEY)).toBe(
      "2024-10-06 03:30:00.000"
    );
  });

  /**
   * The same two rules in zones that break a naive implementation: a northern
   * hemisphere zone (where the repeated hour is 01:00, not 02:00), a 30-minute
   * DST shift, a zone whose standard time is the summer one, and a zone that
   * skipped an entire calendar day. Expectations are Temporal's `compatible`
   * results, which the test below re-derives independently where available.
   */
  it.each([
    // repeated 01:30 -> earlier (EDT, -04:00), not the later EST reading
    ["America/New_York", "2024-11-03 01:30:00.000", "2024-11-03T05:30:00.000Z"],
    // skipped 02:30 -> 03:30 EDT
    ["America/New_York", "2024-03-10 02:30:00.000", "2024-03-10T07:30:00.000Z"],
    // Lord Howe shifts by 30 minutes: repeated 01:45 -> earlier (+11:00)
    ["Australia/Lord_Howe", "2024-04-07 01:45:00.000", "2024-04-06T14:45:00.000Z"],
    // skipped 02:15 -> 02:45 (+11:00)
    ["Australia/Lord_Howe", "2024-10-06 02:15:00.000", "2024-10-05T15:45:00.000Z"],
    // Ireland's "standard" time is the summer one, so the later occurrence is
    // the DST one — a rule phrased in terms of standard time would pick wrong.
    ["Europe/Dublin", "2024-10-27 01:30:00.000", "2024-10-27T00:30:00.000Z"],
    // Samoa skipped all of 2011-12-30; the whole day is a 24-hour gap.
    ["Pacific/Apia", "2011-12-30 12:00:00.000", "2011-12-30T22:00:00.000Z"]
  ])("resolves %s %s to %s", (timeZone, wallClock, expected) => {
    expect(parseSybaseDateTime(wallClock, timeZone)?.toISOString()).toBe(expected);
  });

  // Temporal is the reference implementation of these rules. It is not in every
  // supported Node yet, so this runs as a cross-check when present rather than
  // as the source of truth.
  interface TemporalLike {
    PlainDateTime: {
      from: (iso: string) => {
        toZonedDateTime: (
          timeZone: string,
          options: { disambiguation: string }
        ) => { epochMilliseconds: number };
      };
    };
  }
  const temporal = (globalThis as unknown as { Temporal?: TemporalLike }).Temporal;

  it.skipIf(!temporal)("agrees with Temporal's `compatible` disambiguation", () => {
    const zones = [
      "Australia/Sydney",
      "Australia/Lord_Howe",
      "America/New_York",
      "Europe/Dublin",
      "Pacific/Chatham",
      "America/St_Johns",
      "Asia/Kolkata"
    ];
    // Walk each zone's transition weekends at 15-minute steps of *wall clock*
    // arithmetic, so skipped and repeated wall clocks are both covered.
    const weekends = [
      Date.UTC(2024, 2, 8),
      Date.UTC(2024, 3, 5),
      Date.UTC(2024, 9, 4),
      Date.UTC(2024, 10, 1)
    ];
    for (const timeZone of zones) {
      for (const start of weekends) {
        for (let ms = start; ms < start + 4 * 86_400_000; ms += 900_000) {
          const wall = formatSybaseDateTime(new Date(ms), "UTC");
          const expected = temporal!.PlainDateTime.from(wall.replace(" ", "T")).toZonedDateTime(
            timeZone,
            { disambiguation: "compatible" }
          ).epochMilliseconds;
          expect(parseSybaseDateTime(wall, timeZone)?.getTime(), `${wall} in ${timeZone}`).toBe(
            expected
          );
        }
      }
    }
  });
});

describe("resolveTimeZone", () => {
  it("defaults to UTC", () => {
    expect(resolveTimeZone()).toBe("UTC");
  });

  it("passes a valid zone through", () => {
    expect(resolveTimeZone(SYDNEY)).toBe(SYDNEY);
  });

  // Intl only rejects a bad zone when it is first used, which would surface from
  // the middle of a query — or a transaction — instead of at setup.
  it.each(["Not/AZone", "Australia/Sidney", "GMT+10", ""])("rejects %j", timeZone => {
    expect(() => resolveTimeZone(timeZone)).toThrow(/Invalid timeZone/);
  });
});

describe("decodeDateTimeColumns", () => {
  const rows = [
    {
      WINFkey: "W1",
      title: "SOME SONG",
      dt_rec_added: "2016-06-09 09:48:46.753",
      tot_pr_royalty: "0.0000"
    }
  ];
  const columns = ["WINFkey", "title", "dt_rec_added", "tot_pr_royalty"];
  const columnTypes = ["varchar", "varchar", "datetime", "money"];

  it("converts datetime columns and leaves everything else untouched", () => {
    const [row] = decodeDateTimeColumns(rows, columns, columnTypes, SYDNEY);
    expect(row!.dt_rec_added).toBeInstanceOf(Date);
    expect((row!.dt_rec_added as unknown as Date).toISOString()).toBe("2016-06-08T23:48:46.753Z");
    // A money column arrives as a string and must stay one to keep its digits.
    expect(row!.tot_pr_royalty).toBe("0.0000");
    expect(row!.title).toBe("SOME SONG");
  });

  it("converts smalldatetime too", () => {
    const [row] = decodeDateTimeColumns(
      [{ dt: "2000-01-01 00:00:00.000" }],
      ["dt"],
      ["smalldatetime"],
      SYDNEY
    );
    expect((row!.dt as unknown as Date).toISOString()).toBe("1999-12-31T13:00:00.000Z");
  });

  // Columns are chosen from the result's type metadata, not by sniffing values,
  // so a varchar holding a date is never rewritten.
  it("keeps date-like text in non-datetime columns as text", () => {
    const [row] = decodeDateTimeColumns(
      [{ title: "2016-06-09 09:48:46.753" }],
      ["title"],
      ["varchar"],
      SYDNEY
    );
    expect(row!.title).toBe("2016-06-09 09:48:46.753");
  });

  // A bare date or time is not an instant, and bigdatetime/bigtime carry
  // microseconds a Date would silently truncate, so all four stay as the
  // canonical text the addon produced — which is lossless.
  it.each(["date", "time", "bigdatetime", "bigtime"])("leaves %s columns as text", columnType => {
    const value = columnType === "date" ? "2016-06-09" : "2016-06-09 09:48:46.753456";
    const [row] = decodeDateTimeColumns([{ v: value }], ["v"], [columnType], SYDNEY);
    expect(row!.v).toBe(value);
  });

  it("passes null and undefined through", () => {
    const [row] = decodeDateTimeColumns(
      [{ a: null, b: undefined }],
      ["a", "b"],
      ["datetime", "smalldatetime"],
      SYDNEY
    );
    expect(row!.a).toBeNull();
    expect(row!.b).toBeUndefined();
  });

  it("does not mutate the rows it is given", () => {
    const original = [{ dt: "2016-06-09 09:48:46.753" }];
    decodeDateTimeColumns(original, ["dt"], ["datetime"], SYDNEY);
    expect(original[0]!.dt).toBe("2016-06-09 09:48:46.753");
  });

  // The text comes from the addon in this same package. Keeping the raw string
  // would hand back a `string` where the schema promises a `Date`, and the
  // failure would then surface far away from its cause.
  it("throws when a datetime column is not in the canonical form", () => {
    expect(() =>
      decodeDateTimeColumns([{ dt: "Jun  9 2016 09:48:46:753AM" }], ["dt"], ["datetime"], SYDNEY)
    ).toThrow(/Could not decode datetime column "dt".*out of sync/s);
  });

  // Silently skipping would hand back raw text for every timestamp, which is the
  // failure mode this whole path exists to remove.
  it("throws when the addon reported no column types", () => {
    expect(() => decodeDateTimeColumns(rows, columns, undefined, SYDNEY)).toThrow(
      /did not report column types/
    );
  });

  it("does not touch an empty result", () => {
    expect(decodeDateTimeColumns([], columns, undefined, SYDNEY)).toEqual([]);
  });
});

describe("parseSybaseDateTime rejects impossible calendar dates", () => {
  // Date.UTC rolls these over silently, which would turn a malformed literal
  // into a plausible-looking wrong instant.
  it.each([
    "2016-13-01 00:00:00.000",
    "2016-00-01 00:00:00.000",
    "2016-02-30 00:00:00.000",
    "2023-02-29 00:00:00.000",
    "2016-04-31 00:00:00.000",
    "2016-06-00 00:00:00.000",
    "2016-06-09 24:00:00.000",
    "2016-06-09 09:60:00.000",
    "2016-06-09 09:48:60.000"
  ])("rejects %j", text => {
    expect(parseSybaseDateTime(text, "UTC")).toBeUndefined();
  });

  it("accepts a real leap day", () => {
    expect(parseSybaseDateTime("2024-02-29 12:00:00.003", "UTC")?.toISOString()).toBe(
      "2024-02-29T12:00:00.003Z"
    );
  });
});
