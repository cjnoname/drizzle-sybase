/**
 * Rebuild the native addon (`node-gyp rebuild`) and put it where the loader
 * looks: `src/native/sybase_native.<platform>-<arch>.node`, and `dist/native/`
 * when it exists (the installed package loads from there).
 *
 *   node scripts/build-native.ts
 *
 * node-gyp alone leaves the result in `build/Release/`, which nothing loads: a
 * rebuild would seem to succeed while the old addon kept running. Needs the
 * FreeTDS static library in `deps/` (`scripts/build.sh` or `build-win.ps1`
 * builds it, and the addon, from scratch).
 */

import { execFileSync } from "child_process";
import { copyFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const target = `sybase_native.${process.platform}-${process.arch}.node`;

execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["node-gyp", "rebuild"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});

const built = join(root, "build", "Release", "sybase_native.node");
for (const dir of ["src/native", "dist/native"]) {
  const dest = join(root, dir);
  if (existsSync(dest)) {
    copyFileSync(built, join(dest, target));
    console.log(`==> ${dir}/${target}`);
  }
}
