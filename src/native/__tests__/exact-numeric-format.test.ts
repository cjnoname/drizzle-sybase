/**
 * Builds and runs `exact-numeric-format.c`: binding.c formats money and
 * numeric values itself instead of calling dbconvert, so the output is checked
 * against dbconvert on millions of values. Needs a C compiler and the FreeTDS
 * build in `deps/` (see scripts/build.sh); skipped where either is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const freetds = join(root, "deps", "freetds");
const library = join(freetds, "lib", "libsybdb.a");
const nodeHeaders = join(dirname(dirname(process.execPath)), "include", "node");
const hasCompiler = process.platform !== "win32" && spawnSync("cc", ["--version"]).status === 0;

const runnable = hasCompiler && existsSync(library) && existsSync(join(nodeHeaders, "node_api.h"));

describe.skipIf(!runnable)("money and numeric formatting", () => {
  it("renders every value exactly as dbconvert does", () => {
    const dir = mkdtempSync(join(tmpdir(), "drizzle-sybase-format-"));
    try {
      const binary = join(dir, "check");
      // N-API and libuv are never called here: let the linker leave them out.
      const linkFlags =
        process.platform === "darwin"
          ? ["-Wl,-undefined,dynamic_lookup", "-liconv"]
          : ["-ffunction-sections", "-fdata-sections", "-Wl,--gc-sections", "-lpthread"];
      const build = spawnSync(
        "cc",
        [
          "-O2",
          "-std=gnu11",
          "-Wno-unused-function",
          `-I${join(root, "src", "native")}`,
          `-I${join(freetds, "include")}`,
          `-I${nodeHeaders}`,
          fileURLToPath(new URL("./exact-numeric-format.c", import.meta.url)),
          library,
          ...linkFlags,
          "-o",
          binary
        ],
        { encoding: "utf8" }
      );
      expect(build.status, build.stderr).toBe(0);
      const run = spawnSync(binary, { encoding: "utf8", timeout: 120_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/0 mismatches/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
