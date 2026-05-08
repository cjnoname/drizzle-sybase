# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0](https://github.com/cjnoname/drizzle-sybase/compare/v0.3.1...v1.0.0) (2026-05-08)


### ⚠ BREAKING CHANGES

* remove min pool size option, simplify pool to max-only sizing
* minimum Node.js version raised to 24

### Features

* Colocate tests with source, upgrade CI toolchain ([0dadd00](https://github.com/cjnoname/drizzle-sybase/commit/0dadd001683390047ac47c331b41e998878c90e9))


### Bug Fixes

* Update npm publish commands and remove unnecessary permissions ([5366c5e](https://github.com/cjnoname/drizzle-sybase/commit/5366c5e32ec47e029103505bab61fe5add1c4b5b))


### Code Refactoring

* Remove min pool size option, simplify pool to max-only sizing ([9fd542b](https://github.com/cjnoname/drizzle-sybase/commit/9fd542bc03e69259d507e02ba6cbfa33f2271244))

## [0.3.1](https://github.com/cjnoname/drizzle-sybase/compare/v0.3.0...v0.3.1) (2026-05-08)


### Code Refactoring

* Replace mssqlTable with lightweight sybaseTable implementation and update column type helpers ([3a4e6f1](https://github.com/cjnoname/drizzle-sybase/commit/3a4e6f1284f13df75b91397fab32ba092ccaf6a3))

## [0.3.0](https://github.com/cjnoname/drizzle-sybase/compare/v0.2.0...v0.3.0) (2026-05-08)


### Features

* Initial release ([1cc0fe5](https://github.com/cjnoname/drizzle-sybase/commit/1cc0fe51da58aec2c7e225864c3fca765b310f49))

## [0.2.0] - Unreleased

### Added

- **Error hierarchy**: Fine-grained error classes (`SybaseConnectionError`, `SybaseQueryError`, `SybaseTimeoutError`, `SybasePoolError`) extending base `SybaseError`
- **Transaction isolation levels**: Support `read_uncommitted`, `read_committed`, `repeatable_read`, `serializable` via `transaction()` options
- **Connection pool metrics**: Observable `pool.metrics` with connection counts, query stats, average duration, and acquire timeouts
- **Graceful drain/shutdown**: `pool.drain()` / `db.drain()` to finish in-flight operations before closing
- **Query logging**: `logger` option with `SybaseLogger` interface for query observability (SQL, duration, errors)
- **Pool state accessors**: `isDraining`, `isClosed` properties on pool
- **Comprehensive unit tests**: Query builder SQL generation, error hierarchy, pool state management (67+ new test cases)
- **Code quality tooling**: oxlint + oxfmt configuration (replaces ESLint/Prettier)
- **VSCode integration**: `.vscode/settings.json` and `extensions.json` for oxc extension
- **`npm run check`**: Combined lint + type check script
- **`npm run lint` / `npm run lint:fix`**: oxlint scripts
- **`npm run format`**: oxfmt formatting script

### Improved

- **`escapeString`**: Now strips null bytes (`\0`) that cause db-lib truncation
- **`serializeValue`**: Handles `NaN`/`Infinity` (throws), invalid `Date` (throws), `Buffer` (hex literal), `bigint`
- **OFFSET implementation**: Passes `maxRows` hint to native layer to reduce memory allocation
- **Connection errors**: Now include host/port context for easier debugging
- **Query errors**: Include truncated SQL for debugging without leaking full queries

### Changed

- `SybaseError` moved to dedicated `src/errors.ts` module (re-exported from index for backward compatibility)
- Pool now uses `SybasePoolError` for pool-specific errors and `SybaseTimeoutError` for acquire timeouts
- `transaction()` now accepts optional `SybaseTransactionOptions` parameter

## [0.1.0] - 2024-12-01

### Added

- Initial release
- Native FreeTDS db-lib bindings via N-API (C addon)
- Connection pooling with health checks
- Drizzle-compatible query builders (select/insert/update/delete)
- Real database transactions (BEGIN/COMMIT/ROLLBACK)
- Type-aware result mapping (int → number, bit → boolean, money → string)
- Cross-platform prebuilt binaries (linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64)
- Sybase ASE SQL dialect with SET ROWCOUNT pagination
- CTE (WITH clause) support
- Zod schema generation re-export
