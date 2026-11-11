/**
 * Builds and runs `bulk-parse.c`: the parsers binding.c converts bulk copy
 * values with must convert every value they accept exactly and refuse the
 * rest — checked on millions of values. Needs a C compiler and the FreeTDS
 * build in `deps/` (see scripts/build.sh); skipped where either is missing.
 */
import { describe, expect, it } from "vitest";

import { buildAndRun, runnable } from "./harness.js";

describe.skipIf(!runnable)("bulk copy value parsing", () => {
  it("accepts exactly what converts exactly", () => {
    const { build, run } = buildAndRun("bulk-parse.c");
    expect(build.status, build.stderr).toBe(0);
    expect(run!.status, run!.stderr).toBe(0);
    expect(run!.stdout).toMatch(/ 0 failures/);
  }, 180_000);
});
