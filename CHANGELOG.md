# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-09-11

### Fixed

- `src/generated/` (the ts-proto output for `common.proto`/`graph.proto`/`vector.proto`) was
  gitignored, so it was never actually present in a fresh checkout of this repository —
  typecheck/build/test only ever worked locally because it had been generated once and never
  deleted. This broke the `v0.1.3` publish workflow's `npm run typecheck` step with dozens of
  "Cannot find module" errors before it ever reached `npm publish` (no `0.1.3` package was
  published). Committed the generated output directly (444KB, 4 files) instead of adding
  `protoc` as a CI dependency, since these files change only when the upstream `.proto`
  definitions change. `npm run proto:gen` remains available for regenerating them locally.

## [0.1.3] - 2026-09-11

### Fixed

- `package-lock.json` had accumulated ~225 dependency entries resolved against
  `registry.npmmirror.com` (a third-party npm mirror) instead of the official
  `registry.npmjs.org`, apparently from a local `npm install` that picked up a mirror
  configuration at some point. GitHub Actions runners refuse to fetch packages from a registry
  other than the one npm is configured to use, which broke `npm ci` in the publish workflow when
  tagging `v0.1.2` (that tag's workflow run failed before reaching `npm publish`; no `0.1.2`
  package was ever published). Regenerated the lockfile from a clean install against the
  official registry; `v0.1.2` is skipped in favor of this release.

## [0.1.2] - 2026-09-11

Security and performance review, prompted by a request to audit the codebase for
vulnerabilities and hot-path inefficiencies before continuing to publish releases.

### Fixed

- **Correctness bug**: `ExecutionResult.rowSize()` iterated the entire result table to count
  rows, which advanced the table's internal cursor — calling `rowSize()` before reading rows
  would leave the table exhausted (or partially consumed) for any subsequent `next()`/iteration.
  `ResultTable` now exposes `rowCountHint()`, an O(numBatches) row count that does not touch the
  cursor, and `rowSize()` uses it instead.

### Security

- **Decoder DoS hardening**: the `Any`-typed value decoder's `List`/`Set` branches read an
  element count directly from the wire (`Set`'s count is a `uint32`, up to ~4.29 billion) and
  used it to size a `boolean[]` presence-flags array *before* decoding any element data. Because
  gRPC message size limits are disabled in this SDK (matching the reference Go/Python/Java
  SDKs), a malformed or malicious server response needed only supply enough bytes to satisfy the
  (bounds-checked) null-bitmap read — roughly `size / 8` bytes — to trigger an attempted
  multi-billion-element array allocation well before any per-element bounds check would fail.
  Added a hard cap (`MAX_COMPOSITE_ELEMENT_COUNT`, 10 million elements) checked immediately after
  reading the declared count, and removed the intermediate `boolean[]` allocation entirely in
  favor of testing bits directly against the raw bitmap buffer.
- **Documentation**: the README now explicitly states that connections without a `tls` option
  send the `Authenticate` password in cleartext (matching the reference SDKs' behavior), and
  recommends always configuring TLS outside of `localhost`/trusted-network scenarios. No
  behavioral change; this closes a documentation gap.

### Performance

- `ConnectionPool.release()` looked up the connection to release via
  `Array.from(this.allConnections).find(...)`, an O(n) scan with an array allocation on every
  release call. The pool's internal `allConnections` tracking is now a `Map<Connection,
  PooledConnection>`, making `release()` O(1).
- Node/Edge decoding rebuilt a full `Map<string, TypeSchema>` of property schemas on every
  decoded row, even though the underlying schema is invariant for a given `(graphId,
  elementTypeId)` across all rows in a column. The property-schema lookup now returns the
  original, already-immutable schema map directly instead of copying it per row.
- `ZonedTime`/`ZonedDatetime` decoding constructed a `Date` object (and ran UTC field
  getters/setters) for every single value, even when the table's timezone offset is `0` (UTC,
  the common case). This now short-circuits and skips the `Date` construction entirely when the
  offset is zero.

### Dependencies

- Bumped `tsup` (8.3.5 → 8.5.1) and `vitest` (2.1.8 → 2.1.9), both non-breaking patch/minor
  updates, resolving one of the eight `npm audit` findings. All eight findings are in
  `devDependencies` only (`npm audit --omit=dev` reports zero vulnerabilities for the published
  package's dependency tree); the remaining seven require a major-version bump of `vitest` that
  was judged not worth the compatibility risk this close to a release, given they affect only a
  local dev-server threat model that doesn't apply to this SDK's usage.

## [0.1.1] - 2026-09-11

### Fixed

- `@bufbuild/protobuf` was imported at runtime by the generated gRPC/protobuf bindings
  (`BinaryReader`/`BinaryWriter`) but was only present transitively via the `ts-proto`
  devDependency, so a clean `npm install` of the published `0.1.0` package failed with
  `Cannot find module '@bufbuild/protobuf'`. Declared it as a direct runtime dependency.
- Bumped `@grpc/grpc-js` (1.13.4 → 1.14.4) to pick up a fix for a high-severity denial-of-service
  advisory (GHSA-5375-pq7m-f5r2 / CVE-2026-48068) affecting malformed-request handling.
  `npm audit --omit=dev` now reports zero vulnerabilities.

## [0.1.0] - 2026-09-10

Initial release.

### Added

- gRPC + Protobuf client for NebulaGraph 5.3's `GraphService` (`Authenticate`, `Execute`).
- Byte-level columnar result decoder (`VectorResultTable`) covering every NebulaGraph 5.x value
  type: booleans, all integer widths, floats, strings, `Decimal`, `Date`/`LocalTime`/
  `ZonedTime`/`LocalDatetime`/`ZonedDatetime`, `Duration`, `Geography` (Point/LineString/Polygon),
  embedding vectors, `List`/`Set`/`Map`/`Record`, and graph `Node`/`Edge`/`Path` values.
- Connection pool with round-robin host selection, health checks (`testOnBorrow`), idle
  connection eviction, and configurable exhaustion behavior (queue-and-wait by default, or
  fail-fast via `rejectOnExhausted`).
- `NebulaClient` / `Session` high-level API (`connect`, `getSession`, `withSession`, `execute`).
- Client-side (`ClientErrorCode`) and server-side (`ServerErrorCode`) error code tables ported
  from the reference `nebula-go` SDK, plus a typed error class hierarchy
  (`NebulaGraphRemoteError`, `ConnectionError`, `PoolExhaustedError`, etc.).
- TLS support (one-way and mutual TLS, plus an `insecureSkipVerify` escape hatch for testing).
- Dual ESM + CommonJS package output with bundled TypeScript declarations.

[0.1.4]: https://github.com/MuYiYong/nebula-typescript/releases/tag/v0.1.4
[0.1.3]: https://github.com/MuYiYong/nebula-typescript/releases/tag/v0.1.3
[0.1.2]: https://github.com/MuYiYong/nebula-typescript/releases/tag/v0.1.2
[0.1.1]: https://github.com/MuYiYong/nebula-typescript/releases/tag/v0.1.1
[0.1.0]: https://github.com/MuYiYong/nebula-typescript/releases/tag/v0.1.0
