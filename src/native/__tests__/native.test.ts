import { describe, it, expect } from "vitest";

import { native } from "../index.js";

describe("native binding", () => {
  it("loads successfully", () => {
    expect(native).toBeDefined();
  });

  it("exposes connect function", () => {
    expect(typeof native.connect).toBe("function");
  });

  it("exposes query function", () => {
    expect(typeof native.query).toBe("function");
  });

  it("exposes close function", () => {
    expect(typeof native.close).toBe("function");
  });

  it("exposes isAlive function", () => {
    expect(typeof native.isAlive).toBe("function");
  });

  it("exposes serverCharset function", () => {
    expect(typeof native.serverCharset).toBe("function");
  });

  // A NUL would cut the path short in C and write somewhere else.
  it.each([[undefined], [""], ["a\0b.csv"]])("rejects the file path %j before any query", path => {
    expect(() => native.queryToFile({}, "select 1", { path } as { path: string })).toThrow(
      TypeError
    );
  });

  it("returns FreeTDS version string", () => {
    const version = native.getVersion();
    expect(version).toContain("FreeTDS");
    expect(version).toContain("db-lib");
  });

  // Anything but a handle from connect() must be rejected, never dereferenced.
  it.each([[{}], [42], [null], ["handle"]])("rejects %j as a connection handle", handle => {
    expect(() => native.close(handle)).toThrow(TypeError);
    expect(() => native.isAlive(handle)).toThrow(TypeError);
    expect(() => native.serverCharset(handle)).toThrow(TypeError);
    expect(() => native.query(handle, "select 1")).toThrow(TypeError);
    expect(() => native.queryColumns(handle, "select 1")).toThrow(TypeError);
    expect(() => native.queryToFile(handle, "select 1", { path: "/tmp/never.csv" })).toThrow(
      TypeError
    );
  });
});
