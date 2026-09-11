import { describe, expect, it, vi } from 'vitest';
import { Session } from './session.js';
import type { ExecutionResult } from '../types/result.js';

function fakeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    isSucceeded: true,
    errorCode: '00000',
    errorMessage: '',
    latencyUs: 0,
    summary: undefined,
    cursor: Buffer.alloc(0),
    raiseOnError: vi.fn(),
    rowSize: () => 0,
    hasNext: () => false,
    next: () => {
      throw new Error('no rows');
    },
    columns: () => [],
    columnTypes: () => [],
    [Symbol.iterator]: () => [][Symbol.iterator](),
    ...overrides,
  };
}

function fakeConnection(overrides: Record<string, unknown> = {}) {
  return {
    execute: vi.fn().mockResolvedValue(fakeResult()),
    ping: vi.fn().mockResolvedValue(true),
    getSessionId: vi.fn().mockReturnValue(123n),
    getServerVersion: vi.fn().mockReturnValue('5.3.0'),
    ...overrides,
  } as never;
}

describe('Session', () => {
  it('delegates execute() to the underlying connection', async () => {
    const conn = fakeConnection();
    const session = new Session(conn, async () => {});
    await session.execute('RETURN 1');
    expect(conn.execute).toHaveBeenCalledWith('RETURN 1', undefined);
  });

  it('executeOrThrow calls raiseOnError on the result', async () => {
    const result = fakeResult();
    const conn = fakeConnection({ execute: vi.fn().mockResolvedValue(result) });
    const session = new Session(conn, async () => {});
    await session.executeOrThrow('RETURN 1');
    expect(result.raiseOnError).toHaveBeenCalled();
  });

  it('release() calls the onRelease callback exactly once even if called twice', async () => {
    const onRelease = vi.fn().mockResolvedValue(undefined);
    const conn = fakeConnection();
    const session = new Session(conn, onRelease);
    await session.release();
    await session.release();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('throws when execute() is called after release()', async () => {
    const conn = fakeConnection();
    const session = new Session(conn, async () => {});
    await session.release();
    await expect(session.execute('RETURN 1')).rejects.toThrow(/already been released/);
  });

  it('exposes getSessionId/getServerVersion from the underlying connection', () => {
    const conn = fakeConnection();
    const session = new Session(conn, async () => {});
    expect(session.getSessionId()).toBe(123n);
    expect(session.getServerVersion()).toBe('5.3.0');
  });
});
