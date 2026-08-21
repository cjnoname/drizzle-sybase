import { describe, it, expect } from "vitest";

import { SybaseDialect, escapeName, escapeString, serializeValue } from "../dialect.js";

describe("escapeName", () => {
  it("wraps names in brackets", () => {
    expect(escapeName("users")).toBe("[users]");
    expect(escapeName("user_id")).toBe("[user_id]");
  });

  it("escapes brackets in names", () => {
    expect(escapeName("table]name")).toBe("[table]]name]");
  });
});

describe("escapeString", () => {
  it("wraps strings in single quotes", () => {
    expect(escapeString("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(escapeString("it's")).toBe("'it''s'");
    expect(escapeString("a'b'c")).toBe("'a''b''c'");
  });
});

describe("serializeValue", () => {
  it("serializes null/undefined to NULL", () => {
    expect(serializeValue(null)).toBe("NULL");
    expect(serializeValue(undefined)).toBe("NULL");
  });

  it("serializes numbers", () => {
    expect(serializeValue(42)).toBe("42");
    expect(serializeValue(3.14)).toBe("3.14");
    expect(serializeValue(-1)).toBe("-1");
  });

  it("serializes booleans to 1/0", () => {
    expect(serializeValue(true)).toBe("1");
    expect(serializeValue(false)).toBe("0");
  });

  it("serializes dates without T separator", () => {
    const d = new Date("2024-01-15T10:30:00.000Z");
    expect(serializeValue(d)).toBe("'2024-01-15 10:30:00.000'");
  });

  it("serializes strings with escaping", () => {
    expect(serializeValue("hello")).toBe("'hello'");
    expect(serializeValue("it's a test")).toBe("'it''s a test'");
  });
});

describe("SybaseDialect", () => {
  it("is instantiable", () => {
    const dialect = new SybaseDialect();
    expect(dialect).toBeInstanceOf(SybaseDialect);
  });
});

describe("SybaseDialect#serializeColumnValue", () => {
  const dialect = new SybaseDialect();
  /** Minimal stand-in for a built column: the dialect only reads these members. */
  const column = (sqlType: string, mapToDriverValue?: (v: unknown) => unknown) => ({
    getSQLType: () => sqlType,
    mapToDriverValue
  });

  // ASE rejects a quoted literal against these types outright ("Msg 257:
  // Implicit conversion from datatype 'VARCHAR' to 'MONEY' is not allowed"),
  // and they are exactly the types the driver returns as strings — so without
  // CONVERT they could be read but never written back.
  it.each([
    ["money", "922337203685477.5807"],
    ["smallmoney", "-214748.3647"],
    ["numeric(19,4)", "999999999999999.9999"],
    ["numeric(20,0)", "99999999999999999999"],
    ["decimal(38, 10)", "1.0000000001"],
    ["NUMERIC(10)", "42"],
    ["bigint", "9223372036854775807"]
  ])("wraps a decimal string bound to %s in CONVERT", (sqlType, value) => {
    expect(dialect.serializeColumnValue(value, column(sqlType))).toBe(
      `convert(${sqlType}, '${value}')`
    );
  });

  it("keeps signs and bare fractions", () => {
    expect(dialect.serializeColumnValue("-0.5", column("money"))).toBe("convert(money, '-0.5')");
    expect(dialect.serializeColumnValue("+1", column("money"))).toBe("convert(money, '+1')");
    expect(dialect.serializeColumnValue(".25", column("money"))).toBe("convert(money, '.25')");
  });

  // A bare numeric/decimal would default to (18,0) in ASE, silently rounding the
  // fraction away. Failing loudly beats losing digits.
  it.each(["numeric", "decimal", "int", "varchar(20)", "float"])(
    "leaves a string bound to %s to the normal literal path",
    sqlType => {
      expect(dialect.serializeColumnValue("1.5", column(sqlType))).toBe("'1.5'");
    }
  );

  // Converting would turn today's hard error (Msg 257) into a silent round, so
  // a literal with more fraction digits than the target keeps is not wrapped.
  it.each([
    ["bigint", "1.5"],
    ["numeric(20,0)", "1.5"],
    ["NUMERIC(10)", "0.5"],
    ["money", "1.00005"],
    ["numeric(10,2)", "1.234"]
  ])("refuses to convert %s when %s would be rounded", (sqlType, value) => {
    expect(dialect.serializeColumnValue(value, column(sqlType))).toBe(`'${value}'`);
  });

  // Trailing zeros carry no value, so they must not trip the guard.
  it.each([
    ["bigint", "2.000"],
    ["numeric(10,1)", "1.50"],
    ["money", "1.50000"]
  ])("still converts %s when %s only has trailing zeros", (sqlType, value) => {
    expect(dialect.serializeColumnValue(value, column(sqlType))).toBe(
      `convert(${sqlType}, '${value}')`
    );
  });

  // Anything that is not a well-formed decimal literal keeps the original
  // behaviour rather than being reinterpreted — including values that could
  // otherwise smuggle SQL through an unquoted CONVERT argument.
  it.each(["", "1e5", "0x10", "1.2.3", " 1", "1' or '1", "abc"])(
    "does not wrap the non-literal %j",
    value => {
      expect(dialect.serializeColumnValue(value, column("money"))).toBe(serializeValue(value));
    }
  );

  it("serializes numbers, bigints and null on money columns unchanged", () => {
    expect(dialect.serializeColumnValue(1.5, column("money"))).toBe("1.5");
    expect(dialect.serializeColumnValue(10n, column("numeric(20,0)"))).toBe("10");
    expect(dialect.serializeColumnValue(null, column("money"))).toBe("NULL");
  });

  it("applies mapToDriverValue before deciding", () => {
    const col = column("money", v => `${v as number}.0000`);
    expect(dialect.serializeColumnValue(12, col)).toBe("convert(money, '12.0000')");
  });

  it("renders Dates in the configured server zone", () => {
    const sydney = new SybaseDialect({ timeZone: "Australia/Sydney" });
    const col = { getSQLType: () => "datetime" };
    const instant = new Date("2016-06-08T23:48:46.753Z");

    expect(sydney.serializeColumnValue(instant, col)).toBe("'2016-06-09 09:48:46.753'");
    // The UTC digits are what an unconfigured dialect produces, 10-11 hours out
    // of step with a server on Sydney time.
    expect(new SybaseDialect().serializeColumnValue(instant, col)).toBe(
      "'2016-06-08 23:48:46.753'"
    );
  });

  // String() switches to exponential notation at 1e21, which ASE reads as a
  // float — so an integer a wide numeric could hold exactly would be rounded to
  // a double's precision on the way in.
  it("renders large integers in full rather than as exponents", () => {
    expect(dialect.serializeColumnValue(1e21, column("numeric(38,0)"))).toBe(
      "1000000000000000000000"
    );
    expect(dialect.serializeColumnValue(-1e21, column("numeric(38,0)"))).toBe(
      "-1000000000000000000000"
    );
    expect(serializeValue(1e21)).toBe("1000000000000000000000");
    // Below the threshold, and non-integers, are unchanged.
    expect(serializeValue(1e20)).toBe("100000000000000000000");
    expect(serializeValue(1.5)).toBe("1.5");
  });

  it("escapes the quoted CONVERT argument", () => {
    // Unreachable through the literal guard, but the escaping must not be
    // dropped on the assumption that it is.
    const col = column("money", () => "1'); drop table WINF --");
    expect(dialect.serializeColumnValue(1, col)).toBe("'1''); drop table WINF --'");
  });
});
