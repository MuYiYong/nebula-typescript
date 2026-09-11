/**
 * ConnectionPool — manages a set of authenticated Connections across one or
 * more graphd hosts, providing round-robin load balancing, health checks,
 * request queueing, and lifecycle management.
 *
 * Design synthesizes the three reference SDKs (see findings.md "连接池设计参考点"):
 *  - Round-robin host selection + LIFO free-list + async request queue,
 *    modeled on nebula-go's `driverPool` (findings-go.md section 2).
 *  - `testOnBorrow`-style health check before handing out a connection,
 *    modeled on nebula-java/nebula-python.
 *  - Default behavior on pool exhaustion is to **queue and wait** until
 *    `maxWaitMs` elapses (matching typical Node.js DB driver ergonomics,
 *    e.g. `mysql2`/`pg`), unlike nebula-java's surprising `blockWhenExhausted
 *    = false` default. This is configurable via `blockWhenExhausted: false`
 *    to opt into immediate rejection instead.
 *
 * Concurrency: a Connection is only ever handed out to one caller at a time
 * (borrow/release pattern), so callers get true parallelism across distinct
 * connections, while each individual connection still serializes its own
 * requests (see Connection's class doc) — mirroring NebulaGraph's
 * one-session-one-in-flight-request constraint.
 */

import { Connection, type ConnectionOptions } from '../connection/connection.js';
import { PoolExhaustedError } from '../errors/index.js';

export interface ConnectionPoolOptions extends ConnectionOptions {
  readonly username: string;
  readonly password: string;
  /** One or more "host:port" addresses of graphd instances. */
  readonly hosts: readonly string[];
  /** Minimum number of connections to keep open (pre-warmed). Default 1. */
  readonly minSize?: number;
  /** Maximum number of connections the pool will ever open. Default 10. */
  readonly maxSize?: number;
  /** Maximum idle connections kept around beyond minSize. Default 5. */
  readonly maxIdle?: number;
  /** Maximum time to wait for a connection when the pool is exhausted, in ms.
   * Default: wait indefinitely (subject to the caller's own timeout/AbortSignal). */
  readonly maxWaitMs?: number;
  /** If true, immediately reject instead of queueing when the pool is
   * exhausted (mirrors nebula-java's `blockWhenExhausted=false`). Default false
   * (i.e., queue and wait) — this differs intentionally from nebula-java's
   * default, matching common Node.js DB driver ergonomics. */
  readonly rejectOnExhausted?: boolean;
  /** Validate (ping) a connection before handing it out. Default true. */
  readonly testOnBorrow?: boolean;
  /** Ping timeout used for testOnBorrow / background health checks, in ms. Default 1000. */
  readonly pingTimeoutMs?: number;
  /** Background health-check / idle-cleanup interval, in ms. Default 5000. */
  readonly healthCheckIntervalMs?: number;
  /** Maximum lifetime of a connection before it is retired on release, in ms.
   * Default: unlimited. */
  readonly maxLifetimeMs?: number;
  /** If true, pool creation requires every host to succeed; otherwise only
   * one host needs to succeed. Default false. */
  readonly strictlyServerHealthy?: boolean;
  /** Statements to run on every newly-created connection (e.g. `SESSION SET ...`). */
  readonly preStatements?: readonly string[];
}

const DEFAULTS = {
  minSize: 1,
  maxSize: 10,
  maxIdle: 5,
  maxWaitMs: Number.POSITIVE_INFINITY,
  pingTimeoutMs: 1_000,
  healthCheckIntervalMs: 5_000,
  maxLifetimeMs: Number.POSITIVE_INFINITY,
} as const;

interface PooledConnection {
  readonly connection: Connection;
  readonly createdAt: number;
}

interface Waiter {
  resolve: (conn: PooledConnection) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class ConnectionPool {
  private readonly options: ConnectionPoolOptions;
  private readonly freeConnections: PooledConnection[] = [];
  private readonly allConnections = new Map<Connection, PooledConnection>();
  private readonly waiters: Waiter[] = [];
  private hostIndex = -1;
  private openCount = 0;
  private opening = 0;
  private closed = false;
  private healthCheckTimer: NodeJS.Timeout | undefined;

  private constructor(options: ConnectionPoolOptions) {
    this.options = options;
  }

  /** Creates and initializes a pool: probes hosts and pre-warms `minSize` connections. */
  static async create(options: ConnectionPoolOptions): Promise<ConnectionPool> {
    if (options.hosts.length === 0) {
      throw new PoolExhaustedError(0);
    }
    const pool = new ConnectionPool(options);
    await pool.initialize();
    return pool;
  }

  private async initialize(): Promise<void> {
    const strict = this.options.strictlyServerHealthy ?? false;
    const minSize = Math.max(1, this.options.minSize ?? DEFAULTS.minSize);

    const results = await Promise.allSettled(
      Array.from({ length: minSize }, () => this.openNewConnection()),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        this.freeConnections.push(r.value);
      }
    }
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;

    if (strict && succeeded < results.length) {
      const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      throw firstError.reason;
    }
    if (succeeded === 0) {
      const firstError = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      throw firstError?.reason ?? new PoolExhaustedError(0);
    }

    this.healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, this.options.healthCheckIntervalMs ?? DEFAULTS.healthCheckIntervalMs);
    this.healthCheckTimer.unref?.();
  }

  private nextHost(): string {
    const hosts = this.options.hosts;
    this.hostIndex = (this.hostIndex + 1) % hosts.length;
    return hosts[this.hostIndex]!;
  }

  private async openNewConnection(): Promise<PooledConnection> {
    this.opening++;
    try {
      const host = this.nextHost();
      const connection = await Connection.open(host, this.options.username, this.options.password, {
        connectTimeoutMs: this.options.connectTimeoutMs,
        requestTimeoutMs: this.options.requestTimeoutMs,
        tls: this.options.tls,
        authInfo: this.options.authInfo,
      });
      for (const stmt of this.options.preStatements ?? []) {
        const result = await connection.execute(stmt);
        if (!result.isSucceeded) {
          await connection.close();
          throw new Error(`pre-statement failed: ${stmt}: ${result.errorMessage}`);
        }
      }
      const pooled: PooledConnection = { connection, createdAt: Date.now() };
      this.allConnections.set(connection, pooled);
      this.openCount++;
      return pooled;
    } finally {
      this.opening--;
    }
  }

  private async destroyConnection(pooled: PooledConnection): Promise<void> {
    this.allConnections.delete(pooled.connection);
    this.openCount--;
    try {
      await pooled.connection.close();
    } catch {
      // best-effort
    }
  }

  private isExpired(pooled: PooledConnection): boolean {
    const maxLifetime = this.options.maxLifetimeMs ?? DEFAULTS.maxLifetimeMs;
    return Number.isFinite(maxLifetime) && Date.now() - pooled.createdAt > maxLifetime;
  }

  /** Borrows a connection from the pool, opening a new one if under maxSize,
   * or queueing (default) / rejecting (if rejectOnExhausted) if exhausted. */
  async acquire(): Promise<Connection> {
    if (this.closed) {
      throw new PoolExhaustedError(0);
    }

    for (;;) {
      const pooled = await this.acquireRaw();
      const testOnBorrow = this.options.testOnBorrow ?? true;
      if (pooled.connection.isClosed() || this.isExpired(pooled)) {
        await this.destroyConnection(pooled);
        continue;
      }
      if (!testOnBorrow) {
        return pooled.connection;
      }
      const alive = await pooled.connection.ping(this.options.pingTimeoutMs ?? DEFAULTS.pingTimeoutMs);
      if (alive) {
        return pooled.connection;
      }
      await this.destroyConnection(pooled);
    }
  }

  private acquireRaw(): Promise<PooledConnection> {
    const free = this.freeConnections.pop();
    if (free) {
      return Promise.resolve(free);
    }

    const maxSize = this.options.maxSize ?? DEFAULTS.maxSize;
    if (this.openCount + this.opening < maxSize) {
      return this.openNewConnection();
    }

    // Pool exhausted: reject immediately or queue, per configuration.
    const maxWaitMs = this.options.maxWaitMs ?? DEFAULTS.maxWaitMs;
    if (this.options.rejectOnExhausted) {
      return Promise.reject(new PoolExhaustedError(0));
    }

    return new Promise<PooledConnection>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (Number.isFinite(maxWaitMs)) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new PoolExhaustedError(maxWaitMs));
        }, maxWaitMs);
      }
      this.waiters.push(waiter);
    });
  }

  /** Returns a connection to the pool for reuse. */
  async release(connection: Connection): Promise<void> {
    const pooled = this.allConnections.get(connection);
    if (!pooled) {
      return; // not tracked by this pool (e.g. already destroyed)
    }
    if (pooled.connection.isClosed() || this.isExpired(pooled)) {
      await this.destroyConnection(pooled);
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(pooled);
      return;
    }

    this.freeConnections.push(pooled);
    await this.enforceMaxIdle();
  }

  private async enforceMaxIdle(): Promise<void> {
    const maxIdle = this.options.maxIdle ?? DEFAULTS.maxIdle;
    while (this.freeConnections.length > maxIdle) {
      // Evict the oldest-idle connection first (front of the array).
      const evicted = this.freeConnections.shift();
      if (evicted) await this.destroyConnection(evicted);
    }
  }

  private async runHealthCheck(): Promise<void> {
    if (this.closed) return;
    // Clear expired/dead idle connections.
    const stillFree: PooledConnection[] = [];
    for (const pooled of this.freeConnections) {
      if (pooled.connection.isClosed() || this.isExpired(pooled)) {
        await this.destroyConnection(pooled);
        continue;
      }
      stillFree.push(pooled);
    }
    this.freeConnections.length = 0;
    this.freeConnections.push(...stillFree);

    // Top back up to minSize if we've dropped below it.
    const minSize = this.options.minSize ?? DEFAULTS.minSize;
    const deficit = minSize - (this.openCount + this.opening);
    for (let i = 0; i < deficit; i++) {
      try {
        const pooled = await this.openNewConnection();
        this.freeConnections.push(pooled);
      } catch {
        // best-effort; will retry on next tick
      }
    }
  }

  /** Number of connections currently borrowed (in use). */
  activeCount(): number {
    return this.openCount - this.freeConnections.length;
  }

  /** Number of idle connections available for immediate borrow. */
  idleCount(): number {
    return this.freeConnections.length;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new PoolExhaustedError(0));
    }
    this.waiters.length = 0;
    await Promise.all(Array.from(this.allConnections.values()).map((p) => this.destroyConnection(p)));
  }
}
