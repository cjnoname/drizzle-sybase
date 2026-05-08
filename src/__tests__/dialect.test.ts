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
