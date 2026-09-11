import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PoolExhaustedError } from '../errors/index.js';

// Mock the Connection module before importing ConnectionPool, since
// ConnectionPool depends on Connection.open() doing real gRPC I/O.
vi.mock('../connection/connection.js', () => {
  let idCounter = 0;
  class FakeConnection {
    readonly id = ++idCounter;
    private closed = false;
    static openCalls = 0;
    static shouldFailHosts = new Set<string>();
    static pingResult: (conn: FakeConnection) => boolean = () => true;

    static async open(address: string) {
      FakeConnection.openCalls++;
      if (FakeConnection.shouldFailHosts.has(address)) {
        throw new Error(`connect failed: ${address}`);
      }
      return new FakeConnection();
    }

    isClosed() {
      return this.closed;
    }

    async ping() {
      return FakeConnection.pingResult(this);
    }

    async execute(_stmt: string) {
      return { isSucceeded: true, errorMessage: '' };
    }

    async close() {
      this.closed = true;
    }
  }
  return { Connection: FakeConnection };
});

const { ConnectionPool } = await import('./connectionPool.js');
const { Connection: FakeConnectionImport } = (await import('../connection/connection.js')) as unknown as {
  Connection: {
    openCalls: number;
    shouldFailHosts: Set<string>;
    pingResult: (conn: unknown) => boolean;
  };
};

beforeEach(() => {
  FakeConnectionImport.openCalls = 0;
  FakeConnectionImport.shouldFailHosts = new Set();
  FakeConnectionImport.pingResult = () => true;
});

describe('ConnectionPool', () => {
  it('creates a pool and pre-warms minSize connections', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669', 'h2:9669'],
      username: 'root',
      password: 'x',
      minSize: 2,
    });
    expect(FakeConnectionImport.openCalls).toBe(2);
    await pool.close();
  });

  it('round-robins across hosts when opening new connections', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669', 'h2:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 4,
    });
    // acquire more than minSize to force new connections via round robin
    const c1 = await pool.acquire();
    const c2 = await pool.acquire();
    const c3 = await pool.acquire();
    expect(FakeConnectionImport.openCalls).toBeGreaterThanOrEqual(3);
    await pool.release(c1);
    await pool.release(c2);
    await pool.release(c3);
    await pool.close();
  });

  it('reuses a released connection instead of opening a new one', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 5,
    });
    const opensBefore = FakeConnectionImport.openCalls;
    const conn = await pool.acquire();
    await pool.release(conn);
    const conn2 = await pool.acquire();
    expect(conn2).toBe(conn);
    expect(FakeConnectionImport.openCalls).toBe(opensBefore); // no new opens
    await pool.release(conn2);
    await pool.close();
  });

  it('rejects immediately when exhausted and rejectOnExhausted=true', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 1,
      rejectOnExhausted: true,
    });
    const conn = await pool.acquire(); // takes the only connection
    await expect(pool.acquire()).rejects.toThrow(PoolExhaustedError);
    await pool.release(conn);
    await pool.close();
  });

  it('queues and waits when exhausted by default, resolving on release', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 1,
    });
    const conn = await pool.acquire();
    const waiterPromise = pool.acquire();

    // Give the waiter a tick to register, then release.
    await new Promise((r) => setTimeout(r, 10));
    await pool.release(conn);

    const conn2 = await waiterPromise;
    expect(conn2).toBe(conn);
    await pool.release(conn2);
    await pool.close();
  });

  it('times out a queued waiter after maxWaitMs and rejects with PoolExhaustedError', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 1,
      maxWaitMs: 50,
    });
    const conn = await pool.acquire();
    await expect(pool.acquire()).rejects.toThrow(PoolExhaustedError);
    await pool.release(conn);
    await pool.close();
  });

  it('destroys a connection that fails testOnBorrow and opens a replacement', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 3,
      testOnBorrow: true,
    });
    // First acquire succeeds normally.
    const conn = await pool.acquire();
    await pool.release(conn);

    // Now make ping fail for everyone; acquiring should discard the dead
    // connection and open a fresh one (which will also fail ping and be
    // discarded) until maxSize forces a real error, OR eventually get a
    // connection if we flip pingResult back. We simulate: ping fails once,
    // then succeeds, to verify the retry loop replaces a dead connection.
    let pingCallCount = 0;
    FakeConnectionImport.pingResult = () => {
      pingCallCount++;
      return pingCallCount > 1; // first ping fails, subsequent pings succeed
    };
    const opensBefore = FakeConnectionImport.openCalls;
    const conn2 = await pool.acquire();
    expect(conn2).toBeDefined();
    expect(FakeConnectionImport.openCalls).toBeGreaterThan(opensBefore);
    await pool.release(conn2);
    await pool.close();
  });

  it('strictlyServerHealthy=true fails pool creation if any host fails', async () => {
    FakeConnectionImport.shouldFailHosts = new Set(['bad:9669']);
    await expect(
      ConnectionPool.create({
        hosts: ['h1:9669', 'bad:9669'],
        username: 'root',
        password: 'x',
        minSize: 2,
        strictlyServerHealthy: true,
      }),
    ).rejects.toThrow();
  });

  it('reports idleCount/activeCount correctly', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 2,
    });
    expect(pool.idleCount()).toBe(1);
    const conn = await pool.acquire();
    expect(pool.activeCount()).toBe(1);
    expect(pool.idleCount()).toBe(0);
    await pool.release(conn);
    expect(pool.idleCount()).toBe(1);
    await pool.close();
  });

  it('close() rejects all pending waiters and closes all connections', async () => {
    const pool = await ConnectionPool.create({
      hosts: ['h1:9669'],
      username: 'root',
      password: 'x',
      minSize: 1,
      maxSize: 1,
    });
    const conn = await pool.acquire();
    const waiterPromise = pool.acquire();
    await new Promise((r) => setTimeout(r, 5));
    await pool.close();
    await expect(waiterPromise).rejects.toThrow(PoolExhaustedError);
    void conn;
  });
});
