#!/usr/bin/env node
/**
 * CLI shim for `drizzle-sybase-introspect`.
 *
 * Delegates to {@link runCli}; kept separate from `index.ts` so importing the
 * introspection API never runs the CLI as a side effect.
 */
import { runCli } from "./index.js";

runCli().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
