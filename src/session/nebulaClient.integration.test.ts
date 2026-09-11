/**
 * Integration tests for the high-level NebulaClient/Session/ConnectionPool
 * API against a real NebulaGraph 5.3 instance. See connection.integration.test.ts
 * for lower-level Connection tests; this file focuses on pool/session behavior.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NebulaClient } from '../session/nebulaClient.js';

const HOST = process.env.NEBULA_HOST_PORT ?? '192.168.15.240:39669';
const USER = process.env.NEBULA_USER ?? 'root';
const PASSWORD = process.env.NEBULA_PASSWORD;

describe.skipIf(!PASSWORD)('NebulaClient integration', () => {
  let client: NebulaClient;

  beforeAll(async () => {
    client = await NebulaClient.connect({
      hosts: [HOST],
      username: USER,
      password: PASSWORD!,
      minSize: 1,
      maxSize: 4,
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it('executes a one-shot query', async () => {
    const result = await client.execute('RETURN "one-shot" AS msg');
    expect(result.next().toPrimitive()).toEqual({ msg: 'one-shot' });
  });

  it('runs multiple statements within one session via withSession', async () => {
    await client.withSession(async (session) => {
      const r1 = await session.executeOrThrow('RETURN 1 AS a');
      expect(r1.next().toPrimitive()).toEqual({ a: 1 });
      const r2 = await session.executeOrThrow('RETURN 2 AS b');
      expect(r2.next().toPrimitive()).toEqual({ b: 2 });
    });
  });

  it('propagates NebulaGraphRemoteError from executeOrThrow', async () => {
    await expect(
      client.withSession((session) => session.executeOrThrow('NOT VALID GQL')),
    ).rejects.toThrow(/syntax error/);
  });

  it('handles concurrent requests across multiple pooled connections', async () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      client.withSession(async (session) => {
        const r = await session.executeOrThrow(`RETURN ${i} AS n`);
        return r.next().toPrimitive();
      }),
    );
    const results = await Promise.all(tasks);
    expect(results).toEqual(Array.from({ length: 8 }, (_, i) => ({ n: i })));
  });

  it('releases connections back to the idle pool after use', async () => {
    const idleBefore = client.idleCount();
    await client.execute('RETURN 1');
    expect(client.idleCount()).toBeGreaterThanOrEqual(idleBefore);
    expect(client.activeCount()).toBe(0);
  });
});
