# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0](https://github.com/cjnoname/drizzle-sybase/compare/v1.2.0...v1.3.0) (2026-07-01)


### Features

* Add AGENTS.md and LICENSE file; update README.md with license badge ([1fcccda](https://github.com/cjnoname/drizzle-sybase/commit/1fcccdaf7b3e9891f2f9301166690f0f70e3e896))
* Add FUNDING.yml to enable sponsorship options ([c5ccc23](https://github.com/cjnoname/drizzle-sybase/commit/c5ccc23c54b0dfe36bfb8d098392cb9df461ce8e))
* Add MSVC setup step for Windows builds and update CMake generator to Ninja ([b8980ce](https://github.com/cjnoname/drizzle-sybase/commit/b8980ce362ba56e79a5c4b06d9c31cf8bae85868))


### Bug Fixes

* Update typescript version to 7.0.1-rc in package.json and pnpm-lock.yaml ([b5c7ac5](https://github.com/cjnoname/drizzle-sybase/commit/b5c7ac5707d1c086f8958a103993b0ee1b8e9e55))

## [1.2.0](https://github.com/cjnoname/drizzle-sybase/compare/v1.1.0...v1.2.0) (2026-06-10)


### Features

* Add Sybase schema introspection (drizzle-sybase/introspect) ([f8e6bbc](https://github.com/cjnoname/drizzle-sybase/commit/f8e6bbcd3539781f83550d0aa839e5966bec95b6))


### Bug Fixes

* **ci:** Pass a module object with exports to process.dlopen in smoke test ([ee45c06](https://github.com/cjnoname/drizzle-sybase/commit/ee45c0650a9cbb71398e74ce7ccbbb301f90bfd9))
* **ci:** Strip Node 26 thin-LTO flags from Windows native build ([ee0aeb3](https://github.com/cjnoname/drizzle-sybase/commit/ee0aeb3d785abaab1744e0876d4b685450c730ea))

## [1.1.0](https://github.com/cjnoname/drizzle-sybase/compare/v1.0.2...v1.1.0) (2026-05-11)


### Features

* Add hard timeout support for queries and connection configuration options ([02d5ddb](https://github.com/cjnoname/drizzle-sybase/commit/02d5ddb30f096c8d50017ae30413dcb7dc439ae4))

## [1.0.2](https://github.com/cjnoname/drizzle-sybase/compare/v1.0.1...v1.0.2) (2026-05-09)


### Bug Fixes

* Add Docker build step for linux-arm64 platform in release workflow ([7e352f3](https://github.com/cjnoname/drizzle-sybase/commit/7e352f3c53f3f0db0e32249a41e67dbabf7c270a))

## [1.0.1](https://github.com/cjnoname/drizzle-sybase/compare/v1.0.0...v1.0.1) (2026-05-09)


### Bug Fixes

* Update canary publish command to skip git checks ([8c53650](https://github.com/cjnoname/drizzle-sybase/commit/8c5365037b64f3b945510956eb97e71543b6b07b))
* Update FreeTDS build configuration for improved compatibility and runtime settings ([79daa2b](https://github.com/cjnoname/drizzle-sybase/commit/79daa2b834206f3231245861e55ef9d54fe7e1b5))
* Update FreeTDS build process and improve error handling in native binding loading ([6f8c42d](https://github.com/cjnoname/drizzle-sybase/commit/6f8c42dca72ffbbe9d095c04e544a4981c1b9ceb))
* Update npm publish commands to use pnpm and adjust package manager version ([a31dd75](https://github.com/cjnoname/drizzle-sybase/commit/a31dd758c6d62ac2fbaf52f26e4a27d18fc1e5ea))
* Update release workflow to support Ubuntu 24.04 ARM architecture and remove Docker build steps for linux-arm64 ([89d3414](https://github.com/cjnoname/drizzle-sybase/commit/89d341444eee481e4cd567013e63c8c3f08c4a43))

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
