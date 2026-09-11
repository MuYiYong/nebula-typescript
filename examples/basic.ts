/**
 * Basic usage: connect, run a one-shot query, and clean up.
 *
 * Run with: NEBULA_PASSWORD=... npx tsx examples/basic.ts
 */
import { NebulaClient } from '../src/index.js';

async function main() {
  const client = await NebulaClient.connect({
    hosts: [process.env.NEBULA_HOST_PORT ?? '127.0.0.1:9669'],
    username: process.env.NEBULA_USER ?? 'root',
    password: process.env.NEBULA_PASSWORD ?? '',
  });

  try {
    const result = await client.execute('RETURN 1 AS a, "hello" AS b, true AS c');
    console.log('columns:', result.columns());
    for (const row of result) {
      console.log(row.toPrimitive());
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
