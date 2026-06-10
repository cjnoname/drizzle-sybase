# AGENTS.md

## Project Overview

**drizzle-sybase** — Drizzle ORM driver for **Sybase ASE**, with FreeTDS statically compiled into a native N-API addon.

- Zero system dependencies — FreeTDS is bundled into the prebuilt `.node` binaries
- Prebuilt binaries for darwin/linux (arm64/x64) and win32-x64 ship in the package
- ESM-only, Node.js 24+
- Peer dependency on `drizzle-orm` — never bundle it

## Hard Rules

1. **ESM only, named exports.** No CommonJS, no default exports.
2. **Type-only imports** for types: `import type { Foo } from "..."`.
3. **Never commit secrets.** `.env` holds DB credentials — do not read or echo them into commits.
4. **Native binaries are prebuilt.** The `install` script intentionally skips `node-gyp`. Only rebuild via `pnpm build:native` when `binding.gyp` or `binding.c` changes.
5. **Match Drizzle's dialect contracts.** Query builders and the dialect must conform to `drizzle-orm` interfaces — verify against the peer package, do not guess.
6. **Run `npm run check` before committing.** Fix all lint/type errors first.

## Bug Fixing & Code Changes

- **Fix root causes, not symptoms.** Trace every bug to its origin.
- **Read before writing.** Understand surrounding code, patterns, and invariants before editing.
- **Match existing patterns.** Follow conventions already in the file/module; search for similar code when unsure.
- **No speculative code.** Look up APIs and types in source; do not guess.
- **Fix it properly.** Refactor across files if that is the correct solution — do not minimize the diff at the cost of correctness.
- **Do not touch unrelated files.** Only modify what the task requires; no drive-by changes.
- **Verify your fix.** Run the relevant tests or `npm run check` before claiming it works.
- **No over-engineering.** Solve the actual problem; if a design's complexity is questionable, summarize tradeoffs and ask.

## Commands

```bash
pnpm i                  # Install (use pnpm)
npm run check           # Lint + type check — run before commit
npm run format          # Format (oxfmt)
npm test                # All tests (vitest)
npm run build           # Compile TS -> dist (tsc)
npm run build:native    # Rebuild native addon (node-gyp) — only when C/gyp changes

# Single test file
pnpm exec vitest run src/__tests__/<file>.test.ts
# Pattern match
pnpm exec vitest run -t "test name"
```

## Project Structure

```
src/
├── index.ts            # Public entry — re-exports the driver API
├── connection.ts       # Connection setup over the native addon
├── session.ts          # Drizzle session: query execution, transactions
├── db.ts               # drizzle() factory
├── dialect.ts          # SQL dialect (Sybase-specific SQL generation)
├── table.ts            # Table definition helpers
├── columns/            # Column type definitions
├── query-builders/     # select / insert / update / delete builders
├── errors.ts           # Error types
├── native/             # N-API addon: binding.c + prebuilt *.node per platform
└── introspect/         # Schema introspection -> codegen (CLI: drizzle-sybase-introspect)
```

- Tests live in `__tests__/*.test.ts` alongside the code they cover.
- `dist/` is the build output. `deps/`, `build-freetds/`, `build/` are native build artifacts.

## Code Style

- **Files**: kebab-case.
- **Imports**: ESM with `verbatimModuleSyntax` — use `import type` for type-only imports.
- **Formatting**: handled by oxfmt — just run `npm run format`.
- **Linting**: oxlint (`.oxlintrc.json`).
- **Tests**: Vitest.

## Release

Versioning and changelog are automated via **release-please** (`release-please-config.json`). Use Conventional Commits. Do not manually bump `version` in `package.json`.
