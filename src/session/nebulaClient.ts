/**
 * NebulaClient — the SDK's main entry point. Wraps a ConnectionPool and
 * exposes an ergonomic `getSession()` / `withSession()` API, plus a
 * one-shot `execute()` convenience method for simple scripts that don't
 * need to manage sessions explicitly.
 *
 * API naming follows nebula-python's ConnectionPool + Session convention
 * (per the user-confirmed design decision in task_plan.md), while the
 * underlying pool robustness (round-robin, health checks, request
 * queueing) follows nebula-go's more battle-tested implementation.
 */

import { ConnectionPool, type ConnectionPoolOptions } from '../pool/connectionPool.js';
import { Session } from './session.js';
import type { ExecutionResult } from '../types/result.js';

export type NebulaClientOptions = ConnectionPoolOptions;

export class NebulaClient {
  private constructor(private readonly pool: ConnectionPool) {}

  static async connect(options: NebulaClientOptions): Promise<NebulaClient> {
    const pool = await ConnectionPool.create(options);
    return new NebulaClient(pool);
  }

  /** Borrows a session from the pool. The caller MUST call `session.release()`
   * when done (consider `withSession()` instead to avoid leaks). */
  async getSession(): Promise<Session> {
    const connection = await this.pool.acquire();
    return new Session(connection, (conn) => this.pool.release(conn));
  }

  /** Borrows a session, runs `fn`, and always releases the session
   * afterwards — even if `fn` throws. This is the recommended way to use
   * the client for anything beyond a single one-shot query. */
  async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.getSession();
    try {
      return await fn(session);
    } finally {
      await session.release();
    }
  }

  /** One-shot convenience: borrows a session, executes one statement,
   * releases the session, and returns the result. Prefer `withSession()`
   * when running multiple statements to avoid repeated pool round-trips. */
  async execute(statement: string, timeoutMs?: number): Promise<ExecutionResult> {
    return this.withSession((session) => session.execute(statement, timeoutMs));
  }

  idleCount(): number {
    return this.pool.idleCount();
  }

  activeCount(): number {
    return this.pool.activeCount();
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
