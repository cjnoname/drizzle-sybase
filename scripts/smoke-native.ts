/**
 * Load a built addon and check it works: what CI runs on each platform's binary,
 * under the Node.js it must run on, before it can be published.
 *
 *   node scripts/smoke-native.ts build/Release/sybase_native.node
 *   node scripts/smoke-native.ts --package <dir>   # an installed drizzle-sybase
 *
 * `dlopen` fails on a binary built for another platform, or needing a newer libc
 * or runtime than this machine has; `getVersion` reaches into the statically
 * linked FreeTDS; every function the JS layer calls must be exported.
 */

import { execFileSync } from "child_process";
import { resolve } from "path";

const EXPORTS = [
  "connect",
  "query",
  "bulkBegin",
  "bulkSend",
  "close",
  "isAlive",
  "serverCharset",
  "getVersion"
];

/** The binding's FreeTDS version and the functions it lacks, checked. */
const check = (version: string, missing: string[], from: string): void => {
  if (!version.includes("FreeTDS")) {
    throw new Error(`${from}: unexpected getVersion(): ${version}`);
  }
  if (missing.length > 0) {
    throw new Error(`${from}: missing exports: ${missing.join(", ")}`);
  }
  console.log(
    `${from}: OK on Node ${process.version} ${process.platform}-${process.arch}: ${version}`
  );
};

const [mode, target] = process.argv.slice(2);
if (mode === "--package") {
  // As an application in `dir` would: `import "drizzle-sybase"`, through the
  // package's exports and its own loader. Run from there, so that it resolves.
  const dir = resolve(target ?? ".");
  const code =
    'const { getNative } = await import("drizzle-sybase"); const b = getNative();' +
    `const missing = ${JSON.stringify(EXPORTS)}.filter(name => typeof b[name] !== "function");` +
    "process.stdout.write(JSON.stringify({ version: String(b.getVersion()), missing }));";
  const out = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: dir,
      encoding: "utf8"
    })
  ) as { version: string; missing: string[] };
  check(out.version, out.missing, `drizzle-sybase installed in ${dir}`);
} else if (mode) {
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, resolve(mode));
  const binding = module.exports;
  check(
    String((binding.getVersion as () => unknown)()),
    EXPORTS.filter(name => typeof binding[name] !== "function"),
    mode
  );
} else {
  throw new Error("usage: smoke-native.ts <addon.node> | --package <dir>");
}
