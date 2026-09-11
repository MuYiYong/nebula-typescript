/**
 * nebula-typescript — TypeScript SDK for NebulaGraph 5.3 (gRPC + Protobuf).
 *
 * Node.js-only (server-side): NebulaGraph's Graph service uses raw
 * gRPC-over-HTTP/2, which browsers cannot dial directly without a
 * WebSocket/HTTP gateway. See README.md for details and limitations.
 */

export { NebulaClient, Session, type NebulaClientOptions } from './session/index.js';
export { ConnectionPool, type ConnectionPoolOptions } from './pool/index.js';
export { Connection, type ConnectionOptions } from './connection/connection.js';
export type { TlsOptions } from './connection/tls.js';

export * from './types/index.js';
export * from './errors/index.js';

export { ResultTable, ResultTableRow } from './decode/resultTable.js';
