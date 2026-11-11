/**
 * Builds and runs `exact-numeric-format.c`: binding.c formats money and
 * numeric values itself instead of calling dbconvert, so the output is checked
 * against dbconvert on millions of values. Needs a C compiler and the FreeTDS
 * build in `deps/` (see scripts/build.sh); skipped where either is missing.
 */
import { describe, expect, it } from "vitest";

import { buildAndRun, runnable } from "./harness.js";

describe.skipIf(!runnable)("money and numeric formatting", () => {
  it("renders every value exactly as dbconvert does", () => {
    const { build, run } = buildAndRun("exact-numeric-format.c");
    expect(build.status, build.stderr).toBe(0);
    expect(run!.status, run!.stderr).toBe(0);
    expect(run!.stdout).toMatch(/0 mismatches/);
  }, 180_000);
});
