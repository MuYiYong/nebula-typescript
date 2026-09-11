/**
 * Working with graph values: Node/Edge/Path, and converting results to
 * plain JS values via toPrimitive() vs. inspecting the typed union directly.
 *
 * Run with: NEBULA_PASSWORD=... npx tsx examples/graph-values.ts
 * (assumes the `basketballplayer` sample graph is loaded, as ships with
 * NebulaGraph's official quick-start Docker image / console tutorial)
 */
import { ColumnType, NebulaClient, type NebulaNode } from '../src/index.js';

async function main() {
  const client = await NebulaClient.connect({
    hosts: [process.env.NEBULA_HOST_PORT ?? '127.0.0.1:9669'],
    username: process.env.NEBULA_USER ?? 'root',
    password: process.env.NEBULA_PASSWORD ?? '',
  });

  try {
    await client.withSession(async (session) => {
      await session.executeOrThrow('SESSION SET GRAPH `basketballplayer`');

      // Typed access: check the ColumnType tag before touching `.data`.
      const nodeResult = await session.executeOrThrow('MATCH (n) RETURN n LIMIT 1');
      const row = nodeResult.next();
      const value = row.getValueByName('n');
      if (!value.isNull && value.type === ColumnType.Node) {
        const node: NebulaNode = value.data;
        console.log('node id:', node.nodeId); // bigint
        console.log('type:', node.type, 'labels:', node.labels);
        for (const [propName, propValue] of node.properties) {
          console.log(` - ${propName}:`, propValue.isNull ? null : propValue.data);
        }
      }

      // Plain-object access: toPrimitive() recursively unwraps everything
      // (Node/Edge/Path -> plain objects/arrays, Int64/UInt64 stay as bigint).
      const pathResult = await session.executeOrThrow('MATCH p = (n)-[e]->(m) RETURN p LIMIT 1');
      console.log('path as primitive:', pathResult.next().toPrimitive());
    });
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
