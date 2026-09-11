# API Reference

Full public API surface exported from `@mygraph/nebula-sdk`. See [README.md](./README.md) for a
task-oriented quick start; this document is a reference for every exported symbol.

## Table of Contents

- [Client](#client)
- [Session](#session)
- [ConnectionPool](#connectionpool)
- [Connection](#connection)
- [Result Types](#result-types)
- [Value Types](#value-types)
- [Errors](#errors)

---

## Client

### `NebulaClient`

The main entry point. Wraps a `ConnectionPool`.

```typescript
class NebulaClient {
  static connect(options: NebulaClientOptions): Promise<NebulaClient>;
  getSession(): Promise<Session>;
  withSession<T>(fn: (session: Session) => Promise<T>): Promise<T>;
  execute(statement: string, timeoutMs?: number): Promise<ExecutionResult>;
  idleCount(): number;
  activeCount(): number;
  close(): Promise<void>;
}
```

- `connect(options)` — creates and initializes the underlying pool (pre-warms `minSize`
  connections; probes all configured hosts). Throws if no host is reachable.
- `getSession()` — borrows a `Session` from the pool. **You must call `session.release()`**
  when done, or the pool will eventually starve. Prefer `withSession()`.
- `withSession(fn)` — borrows a session, runs `fn`, and always releases it afterward (even if
  `fn` throws). Use this for anything beyond a single one-shot query, especially statements
  that must share session state (e.g. `SESSION SET GRAPH ...`).
- `execute(statement, timeoutMs?)` — one-shot convenience: borrow, run one statement, release.
  Equivalent to `withSession((s) => s.execute(statement, timeoutMs))`.
- `idleCount()` / `activeCount()` — current pool occupancy, for monitoring.
- `close()` — closes every pooled connection and rejects any queued `acquire()` calls.

### `NebulaClientOptions`

Alias for `ConnectionPoolOptions` (see below).

---

## Session

### `Session`

A borrowed connection, scoped to one caller until released.

```typescript
class Session {
  execute(statement: string, timeoutMs?: number): Promise<ExecutionResult>;
  executeOrThrow(statement: string, timeoutMs?: number): Promise<ExecutionResult>;
  ping(timeoutMs?: number): Promise<boolean>;
  getSessionId(): bigint;
  getServerVersion(): string;
  release(): Promise<void>;
}
```

- `execute` — runs a statement. **Never throws for query-level failures** — check
  `result.isSucceeded` / `result.errorCode` / `result.errorMessage`, or call
  `result.raiseOnError()` yourself.
- `executeOrThrow` — same as `execute`, but calls `result.raiseOnError()` automatically, so a
  failed query throws `NebulaGraphRemoteError`.
- `ping` — runs a lightweight liveness check (`RETURN 1`) against the underlying connection.
- `release` — returns the underlying connection to the pool. Idempotent (safe to call more
  than once). Calling any other method after `release()` throws.

---

## ConnectionPool

### `ConnectionPool`

Lower-level pool primitive; most users should go through `NebulaClient` instead.

```typescript
class ConnectionPool {
  static create(options: ConnectionPoolOptions): Promise<ConnectionPool>;
  acquire(): Promise<Connection>;
  release(connection: Connection): Promise<void>;
  idleCount(): number;
  activeCount(): number;
  close(): Promise<void>;
}
```

### `ConnectionPoolOptions`

```typescript
interface ConnectionPoolOptions extends ConnectionOptions {
  hosts: readonly string[];        // "host:port" list; round-robin
  username: string;
  password: string;

  minSize?: number;                // default 1 — pre-warmed connections
  maxSize?: number;                // default 10 — hard cap
  maxIdle?: number;                // default 5 — idle connections retired beyond this
  maxWaitMs?: number;              // default Infinity — acquire() wait when exhausted
  rejectOnExhausted?: boolean;     // default false — queue vs. fail-fast on exhaustion
  testOnBorrow?: boolean;          // default true — ping before handing out a connection
  pingTimeoutMs?: number;          // default 1000
  healthCheckIntervalMs?: number;  // default 5000 — background idle-cleanup/top-up interval
  maxLifetimeMs?: number;          // default Infinity — retire connections older than this
  strictlyServerHealthy?: boolean; // default false — require every host to succeed on create()
  preStatements?: readonly string[]; // run on every newly created connection
}
```

Inherits `connectTimeoutMs`, `requestTimeoutMs`, `tls`, `authInfo` from `ConnectionOptions`.

**Exhaustion behavior**: by default (`rejectOnExhausted: false`), `acquire()` queues and waits
up to `maxWaitMs` (default: forever) for a connection to free up — matching the ergonomics of
`pg`/`mysql2` and other common Node.js DB drivers. Set `rejectOnExhausted: true` to instead
throw `PoolExhaustedError` immediately when the pool is full.

---

## Connection

### `Connection`

The lowest-level unit: one gRPC channel + one authenticated server-side session. Requests on
the same `Connection` are automatically serialized (NebulaGraph does not allow concurrent
requests on one session) — use the pool for real parallelism across many connections.

```typescript
class Connection {
  static open(address: string, username: string, password: string, options?: ConnectionOptions): Promise<Connection>;
  execute(statement: string, timeoutMs?: number): Promise<ExecutionResult>;
  ping(timeoutMs?: number): Promise<boolean>;
  getSessionId(): bigint;
  getServerVersion(): string;
  isClosed(): boolean;
  close(): Promise<void>;
}
```

### `ConnectionOptions`

```typescript
interface ConnectionOptions {
  connectTimeoutMs?: number; // default 3000
  requestTimeoutMs?: number; // default 60000
  tls?: TlsOptions;
  authInfo?: Record<string, string>; // extra fields merged into the JSON auth payload
}
```

### `TlsOptions`

```typescript
interface TlsOptions {
  ca?: Buffer;                    // PEM-encoded CA certificate
  cert?: Buffer;                  // PEM-encoded client certificate (mutual TLS)
  key?: Buffer;                   // PEM-encoded client private key (mutual TLS)
  insecureSkipVerify?: boolean;   // DANGEROUS — skips server cert verification; testing only
}
```

---

## Result Types

### `ExecutionResult`

Returned by `execute()`/`executeOrThrow()`. Implements `Table` and is iterable.

```typescript
interface ExecutionResult extends Table {
  readonly isSucceeded: boolean;
  readonly errorCode: string;      // GQLSTATUS code, e.g. "00000" on success
  readonly errorMessage: string;
  readonly latencyUs: number;
  readonly summary: Summary | undefined;
  readonly cursor: Buffer;
  raiseOnError(): void;            // throws NebulaGraphRemoteError if !isSucceeded
}
```

### `Table`

```typescript
interface Table {
  rowSize(): number;
  hasNext(): boolean;
  next(): Row;
  columns(): readonly string[];
  columnTypes(): readonly ColumnType[];
  [Symbol.iterator](): IterableIterator<Row>;
}
```

### `Row`

```typescript
interface Row {
  values(): readonly NebulaValueOrNull[];
  getValueByName(name: string): NebulaValueOrNull;
  getValueByIndex(index: number): NebulaValueOrNull;
  toPrimitive(): Record<string, unknown>; // recursively unwraps to plain JS values
}
```

### `Summary`, `PlanInfo`, `QueryStats`, `ElapsedTime`

Query execution metadata (timings, affected node/edge counts, EXPLAIN plan info). See
`src/types/result.ts` for full field lists. `PlanInfo` tree conversion is currently omitted from
`Summary` (returns `undefined`) — raw plan data is available via the underlying proto response
if needed in a future version.

---

## Value Types

### `ColumnType`

Enum tagging every possible decoded value (mirrors the wire-level type codes):
`Node`, `Edge`, `Bool`, `Int8`..`Int64`, `Uint8`..`Uint64`, `Float32`, `Float64`, `String`,
`List`, `Path`, `Record`, `Vector` (embedding), `LocalTime`, `Duration`, `Date`,
`LocalDatetime`, `ZonedTime`, `ZonedDatetime`, `Decimal`, `Geography`, `Set`, `Map`, `Any`.

### `NebulaValue` / `NebulaValueOrNull`

A discriminated union: `{ type: ColumnType; isNull: false; data: T }` for a concrete value, or
`{ type: ColumnType; isNull: true; data: null }` for `NULL`. Always narrow on `isNull` first,
then `type`, before accessing `.data`:

```typescript
const v = row.getValueByName('n');
if (!v.isNull && v.type === ColumnType.Node) {
  console.log(v.data.properties); // TypeScript now knows v.data is NebulaNode
}
```

Helper accessors are also available (`asBool`, `asInt64`, `asString`, `asNode`, `asEdge`,
`asPath`, `asList`, `asSet`, `asMap`, `asRecord`, `asFloat64`) — each throws `NebulaTypeError`
if the value's actual type doesn't match, or if the value is `NULL`.

### `toPrimitive(value)`

Recursively converts a `NebulaValueOrNull` (or a whole `Row` via `row.toPrimitive()`) into
plain JS structures: `List`/`Set`/`Path` → arrays, `Map` → `Map`, `Record`/`Node`/`Edge` →
plain objects, `Decimal` → its string representation, `NULL` → `null`. `Int64`/`Uint64` remain
`bigint`.

### Composite value shapes

```typescript
interface NebulaNode {
  nodeId: bigint;
  graph: string;
  type: string;
  labels: readonly string[];
  properties: ReadonlyMap<string, NebulaValue>;
}

interface NebulaEdge {
  srcId: bigint;
  dstId: bigint;
  direction: EdgeDirection; // Outgoing=0, Incoming=1, NoDirection=2
  graph: string;
  type: string;
  labels: readonly string[];
  rank: bigint;
  properties: ReadonlyMap<string, NebulaValue>;
}

interface NebulaPath {
  values: readonly NebulaValue[]; // alternating Node, Edge, Node, Edge, ..., Node
}

interface NebulaList  { values: readonly NebulaValue[]; }
interface NebulaSet   { values: readonly NebulaValue[]; }
interface NebulaMap   { entries: ReadonlyMap<NebulaValue, NebulaValue>; }
interface NebulaRecord{ values: ReadonlyMap<string, NebulaValue>; }
```

### Date/time shapes

```typescript
interface NebulaDate { year: number; month: number; day: number; }
interface NebulaLocalTime { hour: number; minute: number; sec: number; microsec: number; }
interface NebulaZonedTime extends NebulaLocalTime { offset: number; } // seconds from UTC
interface NebulaLocalDatetime extends NebulaDate, NebulaLocalTime {}
interface NebulaZonedDatetime extends NebulaDate, NebulaLocalTime { offset: number; }
interface NebulaDuration {
  isMonthBased: boolean;
  year: number; month: number; day: number;
  hour: number; minute: number; sec: number; microsec: number;
}
```

### Geography shapes

```typescript
interface NebulaPoint { lng: number; lat: number; }
type NebulaLineString = readonly NebulaPoint[];
type NebulaPolygon = readonly (readonly NebulaPoint[])[]; // rings; first is the outer boundary
interface NebulaGeography {
  srid: number;
  shape: GeoShape;
  point?: NebulaPoint;
  lineString?: NebulaLineString;
  polygon?: NebulaPolygon;
}
```

### `NebulaDecimal` / `NebulaEmbeddingVector`

```typescript
interface NebulaDecimal { sval: string; }             // canonical decimal string, e.g. "3.14"
interface NebulaEmbeddingVector { values: readonly number[]; }
```

---

## Errors

### Client-side errors (`NebulaClientError` subclasses)

| Class | When |
|---|---|
| `AddressNotValidError` | A configured host string failed to parse. |
| `ConnectionError` | Failed to open a gRPC channel. |
| `ConnectionUnavailableError` | gRPC reported `UNAVAILABLE`. |
| `ConnectTimeoutError` | Connecting exceeded `connectTimeoutMs`. |
| `RequestTimeoutError` | A request exceeded its timeout / gRPC deadline. |
| `ConnectionClosedError` | Operation attempted on a closed connection. |
| `PoolExhaustedError` | Pool exhausted and either `rejectOnExhausted` was set, or `maxWaitMs` elapsed. |
| `AuthenticationError` | `Authenticate` failed (bad credentials, or a non-timeout gRPC error). |
| `TlsConfigError` | Invalid TLS configuration (e.g. missing CA when required). |
| `DecodeFailedError` | The columnar result payload could not be decoded. |
| `IllegalArgumentError` / `TypeAssertionError` / `ClientInternalError` | Misuse / internal errors. |

All extend `NebulaClientError extends NebulaError extends Error`, and carry a `.code` (from
`ClientErrorCode`, the `99xxx` range).

### Server-side errors

`NebulaGraphRemoteError` — thrown by `executeOrThrow()` / `result.raiseOnError()` when a query
executes but the server returns a non-`"00000"` GQLSTATUS code. Carries `.code` (a
`ServerErrorCode` string, e.g. `"42001"` for a syntax error) and a human-readable `.message`.

```typescript
export const ServerErrorCode = { SuccessfulCompletion: '00000', InvalidSyntax: '42001', /* ...750+ more */ };
export const ClientErrorCode = { AddressNotValid: '99000', /* ...11 more */ };
```

Both tables are ported verbatim from the reference `nebula-go` SDK's `pkg/errors/error.go`.
