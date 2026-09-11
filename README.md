# nebula-typescript

TypeScript SDK for [NebulaGraph](https://www.nebula-graph.io/) **5.3**, targeting its gRPC +
Protocol Buffers wire protocol (the successor to the older Thrift-based protocol used by
NebulaGraph 3.x and earlier). This SDK talks to the `GraphService` (`Authenticate` / `Execute`)
exposed by `graphd`, decodes its columnar `VectorResultTable` result format, and exposes an
ergonomic connection-pool + session API for Node.js applications.

## Status

Implemented against NebulaGraph **5.3.0** (verified against a live instance). Not affiliated
with or endorsed by vesoft inc.; built from the public `nebula-go`, `nebula-python`, and
`nebula-java` reference SDKs (`release-5.3` branches), since the 5.3 kernel itself is closed
source — the wire protocol is defined by the `.proto` files shipped with those SDKs.

## Requirements & Limitations

- **Node.js >= 18.** This package is server-side only.
- **No browser support.** NebulaGraph's Graph service speaks raw gRPC over HTTP/2. Browsers
  cannot dial this directly (no WebSocket/HTTP gateway is provided by the server), so this SDK
  cannot be used from browser JavaScript. If you need browser/edge access, you must build a
  proxy service that sits in front of `graphd` — that is outside the scope of this SDK.
- Ships as a **dual ESM + CJS package** (`import`/`require` both work).
- Only the `GraphService` is implemented (query execution). Meta/Storage services are not
  covered — this SDK is for running GQL statements, not cluster administration.

## Install

```bash
npm install @mygraph/nebula-sdk
```

## Quick Start

```typescript
import { NebulaClient } from '@mygraph/nebula-sdk';

const client = await NebulaClient.connect({
  hosts: ['127.0.0.1:9669'],
  username: 'root',
  password: process.env.NEBULA_PASSWORD!,
});

// One-shot query (borrows a session, runs one statement, releases it).
const result = await client.execute('RETURN 1 AS a, "hello" AS b');
for (const row of result) {
  console.log(row.toPrimitive()); // { a: 1, b: 'hello' }
}

await client.close();
```

## Running Multiple Statements in One Session

Use `withSession` when you need several statements to share the same server-side session
(e.g. after a `SESSION SET GRAPH ...`), or when issuing many queries and want to avoid the
overhead of borrowing/releasing a connection per statement:

```typescript
await client.withSession(async (session) => {
  await session.executeOrThrow('SESSION SET GRAPH `myGraph`');
  const result = await session.executeOrThrow('MATCH (n) RETURN n LIMIT 10');
  for (const row of result) {
    console.log(row.toPrimitive());
  }
});
```

`executeOrThrow` throws `NebulaGraphRemoteError` if the query fails; the plain `execute` never
throws for query-level failures — check `result.isSucceeded` or call `result.raiseOnError()`
yourself.

## Error Handling

```typescript
import { NebulaGraphRemoteError } from '@mygraph/nebula-sdk';

const result = await client.execute('NOT VALID GQL');
if (!result.isSucceeded) {
  console.log(result.errorCode, result.errorMessage); // e.g. "42001", "syntax error near ..."
}

// Or, to throw instead:
try {
  await client.withSession((s) => s.executeOrThrow('NOT VALID GQL'));
} catch (err) {
  if (err instanceof NebulaGraphRemoteError) {
    console.log('server error code:', err.code);
  }
}
```

Client-side errors (connection failures, timeouts, TLS misconfiguration, pool exhaustion) are
distinct exception classes (`ConnectionError`, `ConnectTimeoutError`, `PoolExhaustedError`,
`AuthenticationError`, etc.) — see [API.md](./API.md) for the full list.

## Connection Pool Options

```typescript
const client = await NebulaClient.connect({
  hosts: ['graphd-1:9669', 'graphd-2:9669'], // multiple hosts, round-robin
  username: 'root',
  password: '...',
  minSize: 2,             // pre-warmed connections
  maxSize: 10,            // hard cap
  maxIdle: 5,             // idle connections retired beyond this
  maxWaitMs: 30_000,      // how long acquire() waits when the pool is exhausted (default: forever)
  rejectOnExhausted: false, // set true to fail fast instead of queueing
  testOnBorrow: true,     // ping a connection before handing it out (default: true)
  maxLifetimeMs: 30 * 60_000, // retire connections older than this on release
});
```

By default, when the pool is exhausted, `acquire()` **queues and waits** (like most Node.js
database drivers, e.g. `pg`/`mysql2`) rather than rejecting immediately. Set
`rejectOnExhausted: true` to opt into fail-fast behavior instead.

## TLS

**Security note:** without a `tls` option, the connection is **unencrypted**, and the
`Authenticate` call sends your username/password in cleartext over the network (matching the
behavior of the reference Go/Python/Java SDKs). Always configure `tls` when connecting over any
network you do not fully control (i.e. anything other than `localhost` or a private, trusted
link to `graphd`).

```typescript
import { readFileSync } from 'node:fs';

const client = await NebulaClient.connect({
  hosts: ['graphd:9669'],
  username: 'root',
  password: '...',
  tls: {
    ca: readFileSync('ca.pem'),
    cert: readFileSync('client.pem'),   // optional, for mutual TLS
    key: readFileSync('client-key.pem'), // optional, for mutual TLS
  },
});
```

## Data Types

Query results are decoded into a discriminated union `NebulaValue` (tagged by `ColumnType`),
covering every NebulaGraph 5.x value type: booleans, all integer widths, floats, strings,
`Decimal`, `Date`/`LocalTime`/`ZonedTime`/`LocalDatetime`/`ZonedDatetime`, `Duration`,
`Geography` (Point/LineString/Polygon), embedding vectors, `List`/`Set`/`Map`/`Record`, and
graph `Node`/`Edge`/`Path` values.

```typescript
import { asNode, ColumnType } from '@mygraph/nebula-sdk';

const result = await client.execute('MATCH (n) RETURN n LIMIT 1');
const row = result.next();
const value = row.getValueByName('n');
if (!value.isNull && value.type === ColumnType.Node) {
  console.log(value.data.type, value.data.labels, value.data.properties);
}

// Or convert directly to plain JS values/objects:
console.log(row.toPrimitive());
```

`Int64`/`UInt64` values are represented as `bigint` (not `number`) to avoid precision loss for
values beyond `Number.MAX_SAFE_INTEGER` — this includes node/edge IDs and session IDs.

## Development

```bash
npm install
npm run proto:gen     # regenerate src/generated/ from proto/*.proto (requires protoc)
npm run build         # dual ESM+CJS build via tsup
npm test              # unit tests (no server required)
npm run test:integration  # requires NEBULA_HOST_PORT / NEBULA_USER / NEBULA_PASSWORD env vars
```

See [examples/](./examples) for more complete usage examples and [API.md](./API.md) for the
full public API reference.

## License

Apache-2.0. The `proto/` definitions are copied from the official
[nebula-go](https://github.com/vesoft-inc/nebula-go) SDK (protocol version 5.0.0), also
Apache-2.0 licensed, copyright vesoft inc.
