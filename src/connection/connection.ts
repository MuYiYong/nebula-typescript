/**
 * Connection — a single gRPC channel to one graphd host, plus (once
 * authenticated) one server-side session. This is the lowest-level unit the
 * connection pool manages; it corresponds to nebula-go's `connection`
 * (findings-go.md section 1.3/3) and nebula-python's `NebulaClient`
 * (findings-python.md section 2.1).
 *
 * Concurrency: Execute/Ping/Close on the same Connection are serialized via
 * an internal promise chain (mirroring the mutex used by every reference
 * SDK — see findings-go.md section 3.4, findings-python.md section 8.2,
 * findings-java.md section 4). Concurrency across *different* Connections
 * is unaffected; the pool is what provides real parallelism.
 */

import * as grpc from '@grpc/grpc-js';
import { ClientInfo_Language, type ClientInfo } from '../generated/nebula/common.js';
import { GraphServiceClient, type AuthResponse, type ExecuteResponse } from '../generated/nebula/graph.js';
import {
  AuthenticationError,
  ConnectTimeoutError,
  ConnectionClosedError,
  ConnectionUnavailableError,
  DecodeFailedError,
  RequestTimeoutError,
  isSuccessCode,
  NebulaGraphRemoteError,
} from '../errors/index.js';
import { ResultTable } from '../decode/resultTable.js';
import type { ExecutionResult, Summary } from '../types/result.js';
import type { TlsOptions } from './tls.js';

export const PROTOCOL_VERSION = '5.0.0';
export const SDK_VERSION = '0.1.0';
const SESSION_CLOSE_STMT = 'SESSION CLOSE';
const PING_STMT = 'RETURN 1';

export interface ConnectionOptions {
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly tls?: TlsOptions;
  /** Extra fields merged into the JSON auth_info payload alongside password. */
  readonly authInfo?: Record<string, string>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function buildChannelCredentials(tls: TlsOptions | undefined): grpc.ChannelCredentials {
  if (!tls) {
    return grpc.credentials.createInsecure();
  }
  if (tls.insecureSkipVerify) {
    return grpc.credentials.createSsl(tls.ca ?? null, tls.key ?? null, tls.cert ?? null, {
      rejectUnauthorized: false,
    });
  }
  if (!tls.ca) {
    throw new AuthenticationError('TLS enabled but no CA certificate was provided');
  }
  return grpc.credentials.createSsl(tls.ca, tls.key ?? null, tls.cert ?? null);
}

function mapGrpcError(address: string, err: grpc.ServiceError, timeoutMs: number): Error {
  switch (err.code) {
    case grpc.status.DEADLINE_EXCEEDED:
    case grpc.status.CANCELLED:
      return new RequestTimeoutError(address, timeoutMs);
    case grpc.status.UNAVAILABLE:
      return new ConnectionUnavailableError(address, err);
    default:
      return err;
  }
}

class ResultTableAdapter implements ExecutionResult {
  private readonly table: ResultTable;

  constructor(private readonly response: ExecuteResponse) {
    this.table = new ResultTable(response.result);
  }

  get isSucceeded(): boolean {
    return isSuccessCode(this.errorCode);
  }

  get errorCode(): string {
    return this.response.status?.code.toString('utf-8') ?? '';
  }

  get errorMessage(): string {
    return this.response.status?.message.toString('utf-8') ?? '';
  }

  get latencyUs(): number {
    return Number(this.response.summary?.elapsedTime?.totalServerTimeUs ?? 0n);
  }

  get summary(): Summary | undefined {
    const s = this.response.summary;
    if (!s) return undefined;
    return {
      elapsedTime: {
        totalServerTimeUs: s.elapsedTime?.totalServerTimeUs ?? 0n,
        buildTimeUs: s.elapsedTime?.buildTimeUs ?? 0n,
        optimizeTimeUs: s.elapsedTime?.optimizeTimeUs ?? 0n,
        serializeTimeUs: s.elapsedTime?.serializeTimeUs ?? 0n,
        parseTimeUs: s.elapsedTime?.parseTimeUs ?? 0n,
      },
      explainType: s.explainType.toString('utf-8'),
      planInfo: undefined,
      queryStats: s.queryStats
        ? {
            numAffectedNodes: s.queryStats.numAffectedNodes,
            numAffectedEdges: s.queryStats.numAffectedEdges,
            exportedPaths: s.queryStats.exportedPaths.map((p) => p.toString('utf-8')),
            numExportedRecords: s.queryStats.numExportedRecords,
          }
        : undefined,
      logStream: s.logStream.toString('utf-8'),
      numWarnings: Number(s.numWarnings),
    };
  }

  get cursor(): Buffer {
    return this.response.cursor;
  }

  raiseOnError(): void {
    if (!this.isSucceeded) {
      throw new NebulaGraphRemoteError(this.errorCode, this.errorMessage);
    }
  }

  rowSize(): number {
    return this.table.rowCountHint();
  }

  hasNext(): boolean {
    return this.table.hasNext();
  }

  next() {
    return this.table.next();
  }

  columns(): readonly string[] {
    return this.table.columnNames;
  }

  columnTypes() {
    return this.table.columnTypes();
  }

  [Symbol.iterator]() {
    return this.table[Symbol.iterator]();
  }
}

export class Connection {
  private readonly client: GraphServiceClient;
  private sessionId: bigint | undefined;
  private serverVersion = '';
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  /** Serializes Execute/Ping/Close calls on this connection (see module doc). */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly address: string,
    client: GraphServiceClient,
    options: ConnectionOptions,
  ) {
    this.client = client;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Opens a channel and authenticates in one step. */
  static async open(
    address: string,
    username: string,
    password: string,
    options: ConnectionOptions = {},
  ): Promise<Connection> {
    const credentials = buildChannelCredentials(options.tls);
    const channelOptions: grpc.ChannelOptions = {
      'grpc.max_send_message_length': -1,
      'grpc.max_receive_message_length': -1,
    };
    const client = new GraphServiceClient(address, credentials, channelOptions);

    const connection = new Connection(address, client, options);
    await connection.waitForReady(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    await connection.authenticate(username, password, options.authInfo);
    return connection;
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      this.client.waitForReady(deadline, (err) => {
        if (err) {
          reject(new ConnectTimeoutError(this.address, timeoutMs));
        } else {
          resolve();
        }
      });
    });
  }

  private authenticate(
    username: string,
    password: string,
    extraAuthInfo?: Record<string, string>,
  ): Promise<void> {
    const authInfoObj: Record<string, string> = { password, ...extraAuthInfo };
    const clientInfo: ClientInfo = {
      lang: ClientInfo_Language.JAVASCRIPT,
      protocolVersion: Buffer.from(PROTOCOL_VERSION, 'utf-8'),
      version: Buffer.from(SDK_VERSION, 'utf-8'),
    };

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + this.connectTimeoutMs;
      this.client.authenticate(
        {
          username: Buffer.from(username, 'utf-8'),
          authInfo: Buffer.from(JSON.stringify(authInfoObj), 'utf-8'),
          clientInfo,
        },
        new grpc.Metadata(),
        { deadline },
        (err: grpc.ServiceError | null, response?: AuthResponse) => {
          if (err) {
            reject(new AuthenticationError(err.message));
            return;
          }
          if (!response) {
            reject(new AuthenticationError('empty auth response'));
            return;
          }
          const code = response.status?.code.toString('utf-8') ?? '';
          if (!isSuccessCode(code)) {
            reject(new AuthenticationError(response.status?.message.toString('utf-8') ?? code));
            return;
          }
          this.sessionId = response.sessionId;
          this.serverVersion = response.version.toString('utf-8');
          resolve();
        },
      );
    });
  }

  getSessionId(): bigint {
    if (this.sessionId === undefined) {
      throw new ConnectionClosedError(this.address);
    }
    return this.sessionId;
  }

  getServerVersion(): string {
    return this.serverVersion;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Runs `fn` after all previously queued operations on this connection
   * complete, ensuring per-connection serialization. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  execute(statement: string, timeoutMs?: number): Promise<ExecutionResult> {
    return this.enqueue(() => this.executeInternal(statement, timeoutMs));
  }

  private executeInternal(statement: string, timeoutMs?: number): Promise<ExecutionResult> {
    if (this.closed) {
      return Promise.reject(new ConnectionClosedError(this.address));
    }
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    const deadline = Date.now() + effectiveTimeout;
    return new Promise((resolve, reject) => {
      this.client.execute(
        { sessionId: this.getSessionId(), stmt: Buffer.from(statement, 'utf-8') },
        new grpc.Metadata(),
        { deadline },
        (err: grpc.ServiceError | null, response?: ExecuteResponse) => {
          if (err) {
            reject(mapGrpcError(this.address, err, effectiveTimeout));
            return;
          }
          if (!response) {
            reject(new DecodeFailedError('empty execute response'));
            return;
          }
          try {
            resolve(new ResultTableAdapter(response));
          } catch (decodeErr) {
            reject(
              new DecodeFailedError(decodeErr instanceof Error ? decodeErr.message : String(decodeErr)),
            );
          }
        },
      );
    });
  }

  ping(timeoutMs = 1_000): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.closed) return false;
      try {
        const result = await this.executeInternal(PING_STMT, timeoutMs);
        return result.isSucceeded;
      } catch {
        return false;
      }
    });
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      if (this.sessionId !== undefined) {
        try {
          await this.executeInternal(SESSION_CLOSE_STMT, 1_000);
        } catch {
          // best-effort logout; ignore errors
        }
      }
      this.client.close();
    });
  }
}
