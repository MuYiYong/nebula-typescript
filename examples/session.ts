/**
 * Session-scoped usage: run several statements against the same
 * server-side session (needed after `SESSION SET GRAPH ...`), and handle
 * both success and failure explicitly.
 *
 * Run with: NEBULA_PASSWORD=... npx tsx examples/session.ts
 */
import { NebulaClient, NebulaGraphRemoteError } from '../src/index.js';

async function main() {
  const client = await NebulaClient.connect({
    hosts: [process.env.NEBULA_HOST_PORT ?? '127.0.0.1:9669'],
    username: process.env.NEBULA_USER ?? 'root',
    password: process.env.NEBULA_PASSWORD ?? '',
  });

  try {
    await client.withSession(async (session) => {
      // SESSION SET GRAPH scopes subsequent statements to a specific graph;
      // this only works if run within the same session, hence withSession.
      await session.executeOrThrow('SESSION SET GRAPH `basketballplayer`');

      const players = await session.executeOrThrow('MATCH (n) RETURN n LIMIT 5');
      for (const row of players) {
        console.log(row.toPrimitive());
      }

      // Errors can be checked without throwing:
      const bad = await session.execute('NOT VALID GQL');
      if (!bad.isSucceeded) {
        console.log('query failed:', bad.errorCode, bad.errorMessage);
      }

      // ...or thrown, and caught as a typed error:
      try {
        await session.executeOrThrow('NOT VALID GQL');
      } catch (err) {
        if (err instanceof NebulaGraphRemoteError) {
          console.log('caught NebulaGraphRemoteError:', err.code, err.message);
        }
      }
    });
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
