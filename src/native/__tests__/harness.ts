/**
 * Builds a C check that includes binding.c, against the FreeTDS build in
 * `deps/`, and runs it. Used by the tests of binding.c's own parsers and
 * formatters; `runnable` is false where a C compiler or that build is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const freetds = join(root, "deps", "freetds");
const library = join(freetds, "lib", "libsybdb.a");
const nodeHeaders = join(dirname(dirname(process.execPath)), "include", "node");
const hasCompiler = process.platform !== "win32" && spawnSync("cc", ["--version"]).status === 0;

export const runnable =
  hasCompiler && existsSync(library) && existsSync(join(nodeHeaders, "node_api.h"));

// For the architecture of the Node.js running the tests (an x64 Node.js on an
// arm64 Mac runs x64 builds), and with any CFLAGS / LDFLAGS given — a sanitizer
// build of FreeTDS needs its runtime linked here too.
const archFlags =
  process.platform === "darwin" ? ["-arch", process.arch === "x64" ? "x86_64" : "arm64"] : [];
const envFlags = (name: string) => (process.env[name] ?? "").split(/\s+/).filter(Boolean);
// N-API and libuv are never called here: let the linker leave them out.
const linkFlags =
  process.platform === "darwin"
    ? ["-Wl,-undefined,dynamic_lookup", "-liconv"]
    : ["-ffunction-sections", "-fdata-sections", "-Wl,--gc-sections", "-lpthread"];

/** Build `source` (a file in this directory) and run it: its build and its run. */
export const buildAndRun = (source: string) => {
  const dir = mkdtempSync(join(tmpdir(), "drizzle-sybase-check-"));
  try {
    const binary = join(dir, "check");
    const build = spawnSync(
      "cc",
      [
        ...archFlags,
        ...envFlags("CFLAGS"),
        "-O2",
        "-std=gnu11",
        "-Wno-unused-function",
        `-I${join(root, "src", "native")}`,
        `-I${join(freetds, "include")}`,
        `-I${nodeHeaders}`,
        fileURLToPath(new URL(`./${source}`, import.meta.url)),
        library,
        ...linkFlags,
        ...envFlags("LDFLAGS"),
        "-o",
        binary
      ],
      { encoding: "utf8" }
    );
    const run =
      build.status === 0 ? spawnSync(binary, { encoding: "utf8", timeout: 120_000 }) : undefined;
    return { build, run };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
