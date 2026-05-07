import { describe, it, expect } from "vitest";

import { native } from "../src/native/index.js";

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

  it("returns FreeTDS version string", () => {
    const version = native.getVersion();
    expect(version).toContain("FreeTDS");
    expect(version).toContain("db-lib");
  });
});
