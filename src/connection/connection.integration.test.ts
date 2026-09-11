/**
 * Integration tests against a real NebulaGraph 5.3 instance.
 *
 * Configure via environment variables:
 *   NEBULA_HOST_PORT (default 192.168.15.240:39669)
 *   NEBULA_USER      (default root)
 *   NEBULA_PASSWORD  (required — no default; tests fail fast if unset)
 *
 * Run with: npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../connection/connection.js';

const HOST = process.env.NEBULA_HOST_PORT ?? '192.168.15.240:39669';
const USER = process.env.NEBULA_USER ?? 'root';
const PASSWORD = process.env.NEBULA_PASSWORD;

describe.skipIf(!PASSWORD)('Connection integration', () => {
  let conn: Connection;

  beforeAll(async () => {
    conn = await Connection.open(HOST, USER, PASSWORD!, {
      connectTimeoutMs: 5000,
      requestTimeoutMs: 10000,
    });
  });

  afterAll(async () => {
    await conn?.close();
  });

  it('authenticates and reports a server version', () => {
    expect(conn.getServerVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('has a valid session id', () => {
    expect(conn.getSessionId()).toBeGreaterThan(0n);
  });

  it('responds to ping', async () => {
    expect(await conn.ping()).toBe(true);
  });

  it('executes a literal query and decodes basic types correctly', async () => {
    const result = await conn.execute('RETURN 1 AS a, "hello" AS b, true AS c');
    expect(result.isSucceeded).toBe(true);
    expect(result.columns()).toEqual(['a', 'b', 'c']);
    const row = result.next();
    expect(row.toPrimitive()).toEqual({ a: 1, b: 'hello', c: true });
  });

  it('decodes a List literal', async () => {
    const result = await conn.execute('RETURN [1,2,3] AS lst');
    result.raiseOnError();
    const row = result.next();
    expect(row.toPrimitive()).toEqual({ lst: [1, 2, 3] });
  });

  it('decodes a Record literal', async () => {
    const result = await conn.execute('RETURN {x: 1, y: "z"} AS rec');
    result.raiseOnError();
    const row = result.next();
    expect(row.toPrimitive()).toEqual({ rec: { x: 1, y: 'z' } });
  });

  it('decodes a {"key": value} literal as a Record (GQL string-keyed literal semantics)', async () => {
    const result = await conn.execute('RETURN {"k1": 1, "k2": 2} AS m');
    result.raiseOnError();
    const row = result.next();
    expect(row.toPrimitive()).toEqual({ m: { k1: 1, k2: 2 } });
  });

  it('decodes NULL', async () => {
    const result = await conn.execute('RETURN NULL AS n');
    result.raiseOnError();
    const row = result.next();
    expect(row.toPrimitive()).toEqual({ n: null });
  });

  it('decodes a Decimal literal', async () => {
    const result = await conn.execute('RETURN 3.14 AS pi');
    result.raiseOnError();
    const row = result.next();
    expect(row.toPrimitive()).toEqual({ pi: '3.14' });
  });

  it('surfaces a syntax error via errorCode/errorMessage without throwing', async () => {
    const result = await conn.execute('NOT VALID GQL SYNTAX');
    expect(result.isSucceeded).toBe(false);
    expect(result.errorCode).toBe('42001');
    expect(result.errorMessage).toContain('syntax error');
  });

  it('raiseOnError throws NebulaGraphRemoteError on a failed query', async () => {
    const result = await conn.execute('NOT VALID GQL SYNTAX');
    expect(() => result.raiseOnError()).toThrow();
  });

  describe('against the basketballplayer sample graph', () => {
    beforeAll(async () => {
      const r = await conn.execute('SESSION SET GRAPH `basketballplayer`');
      r.raiseOnError();
    });

    it('decodes a real Node with properties (including a Date field)', async () => {
      const result = await conn.execute('MATCH (n) RETURN n LIMIT 1');
      result.raiseOnError();
      const row = result.next();
      const primitive = row.toPrimitive() as {
        n: { nodeId: bigint; graph: string; type: string; labels: string[]; properties: Record<string, unknown> };
      };
      expect(primitive.n.graph).toBe('basketballplayer');
      expect(typeof primitive.n.type).toBe('string');
      expect(Array.isArray(primitive.n.labels)).toBe(true);
      expect(typeof primitive.n.nodeId).toBe('bigint');
    });

    it('decodes a real Edge with direction and rank', async () => {
      const result = await conn.execute('MATCH ()-[e]->() RETURN e LIMIT 1');
      result.raiseOnError();
      const row = result.next();
      const primitive = row.toPrimitive() as {
        e: { srcId: bigint; dstId: bigint; rank: bigint; direction: number; graph: string };
      };
      expect(primitive.e.graph).toBe('basketballplayer');
      expect(typeof primitive.e.srcId).toBe('bigint');
      expect(typeof primitive.e.rank).toBe('bigint');
    });

    it('decodes a real Path alternating Node/Edge/Node', async () => {
      const result = await conn.execute('MATCH p = (n)-[e]->(m) RETURN p LIMIT 1');
      result.raiseOnError();
      const row = result.next();
      const primitive = row.toPrimitive() as { p: unknown[] };
      expect(primitive.p.length).toBe(3);
      const [first, second, third] = primitive.p as [
        { nodeId: bigint },
        { srcId: bigint },
        { nodeId: bigint },
      ];
      expect(typeof first.nodeId).toBe('bigint');
      expect(typeof second.srcId).toBe('bigint');
      expect(typeof third.nodeId).toBe('bigint');
    });
  });
});
