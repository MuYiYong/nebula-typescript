/**
 * Session — a user-facing handle to one borrowed Connection from a
 * NebulaClient's pool. Mirrors nebula-python's `NebulaClient` object
 * (which conflates "connection" and "session" into one borrowed unit —
 * see findings-python.md section 1.3) while keeping the class name
 * `Session` for clarity in this SDK's own API surface.
 *
 * A Session must be released back to the pool via `session.release()` (or
 * `using`-style via `NebulaClient.withSession()`) once the caller is done;
 * forgetting to release it will eventually starve the pool.
 */

import type { Connection } from '../connection/connection.js';
import type { ExecutionResult } from '../types/result.js';

export class Session {
  private released = false;

  constructor(
    private readonly connection: Connection,
    private readonly onRelease: (connection: Connection) => Promise<void>,
  ) {}

  /** Executes a GQL statement and returns the decoded result. Does not
   * throw on a query-level failure (non-"00000" status) — check
   * `result.isSucceeded` or call `result.raiseOnError()`. */
  async execute(statement: string, timeoutMs?: number): Promise<ExecutionResult> {
    this.assertNotReleased();
    return this.connection.execute(statement, timeoutMs);
  }

  /** Convenience wrapper: executes and throws NebulaGraphRemoteError on failure. */
  async executeOrThrow(statement: string, timeoutMs?: number): Promise<ExecutionResult> {
    const result = await this.execute(statement, timeoutMs);
    result.raiseOnError();
    return result;
  }

  async ping(timeoutMs?: number): Promise<boolean> {
    this.assertNotReleased();
    return this.connection.ping(timeoutMs);
  }

  getSessionId(): bigint {
    return this.connection.getSessionId();
  }

  getServerVersion(): string {
    return this.connection.getServerVersion();
  }

  /** Releases this session's underlying connection back to the pool.
   * Safe to call multiple times; subsequent calls are no-ops. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.onRelease(this.connection);
  }

  private assertNotReleased(): void {
    if (this.released) {
      throw new Error('Session has already been released back to the pool');
    }
  }
}
