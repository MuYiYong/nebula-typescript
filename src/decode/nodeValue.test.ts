import { describe, expect, it } from 'vitest';
import type { NestedVector, VectorResultTable } from '../generated/nebula/vector.js';
import { ColumnType } from '../types/columnType.js';
import { ResultTable } from './resultTable.js';
import './values.js';

function nv(overrides: Partial<NestedVector>): NestedVector {
  return {
    numNestedVectors: 0,
    commonMetaData: { numRecords: 1, vectorContentType: 2 },
    specialMetaData: Buffer.alloc(0),
    vectorData: Buffer.alloc(0),
    nullBitMap: Buffer.alloc(0),
    nestedVectors: [],
    ...overrides,
  };
}

/** Builds a Node type schema byte stream:
 *  [Node] + numElementType(4) + { graphId(4) + nodeTypeId(2) + numProps(4) +
 *  { nameLen(2)+name+propType } }
 */
function buildNodeTypeSchema(
  graphId: number,
  nodeTypeId: number,
  props: { name: string; type: ColumnType }[],
): Buffer {
  const parts: Buffer[] = [Buffer.from([ColumnType.Node])];
  parts.push(Buffer.from([1, 0, 0, 0])); // numElementType = 1
  parts.push(int32(graphId));
  parts.push(int16(nodeTypeId));
  parts.push(int32(props.length));
  for (const p of props) {
    const nameBuf = Buffer.from(p.name, 'utf-8');
    parts.push(int16(nameBuf.length));
    parts.push(nameBuf);
    parts.push(Buffer.from([p.type]));
  }
  return Buffer.concat(parts);
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}
function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16LE(n, 0);
  return b;
}

/** special_meta_data for a Node column:
 *  propsNum(4) + { nameLen(2)+name } + elementTypeNum(4) +
 *  { graphId(4) + nodeTypeId(2) + propNum(4) + { vectorIndex(4) } }
 */
function buildNodeSpecialMetaData(
  propNames: string[],
  graphId: number,
  nodeTypeId: number,
  vectorIndexes: number[],
): Buffer {
  const parts: Buffer[] = [int32(propNames.length)];
  for (const name of propNames) {
    const nameBuf = Buffer.from(name, 'utf-8');
    parts.push(int16(nameBuf.length));
    parts.push(nameBuf);
  }
  parts.push(int32(1)); // elementTypeNum
  parts.push(int32(graphId));
  parts.push(int16(nodeTypeId));
  parts.push(int32(vectorIndexes.length));
  for (const vi of vectorIndexes) parts.push(int32(vi));
  return Buffer.concat(parts);
}

function buildTable(
  columnNames: string[],
  columnTypes: Buffer[],
  vectors: NestedVector[],
  graphSchema: VectorResultTable['meta'] extends infer M
    ? M extends { graphSchema: infer G }
      ? G
      : never
    : never = [],
): VectorResultTable {
  return {
    dataLayoutVersion: Buffer.alloc(0),
    meta: {
      tableType: 0,
      numRecords: 1,
      rowType: {
        numColumns: columnNames.length,
        columnNames,
        columnTypes: columnTypes.map((b) => ({ valueType: b })),
      },
      numBatches: 1,
      timeZoneOffset: 0,
      isLittleEndian: true,
      graphSchema,
    },
    batch: [{ vectors }],
  };
}

describe('Node decoding', () => {
  it('decodes a Node with one Int32 property', () => {
    const graphId = 1;
    const nodeTypeId = 7;
    const nodeId = (BigInt(nodeTypeId) << 48n) | 123n; // encode typeId in high bits + real id in low bits

    const header = Buffer.alloc(16);
    header.writeBigInt64LE(nodeId, 0);
    header.writeInt32LE(graphId, 8);
    // bytes 12-16 padding

    const ageVector = nv({ vectorData: int32(30) });

    const schema = buildNodeTypeSchema(graphId, nodeTypeId, [{ name: 'age', type: ColumnType.Int32 }]);
    const specialMetaData = buildNodeSpecialMetaData(['age'], graphId, nodeTypeId, [0]);

    const table = buildTable(
      ['n'],
      [schema],
      [nv({ vectorData: header, specialMetaData, nestedVectors: [ageVector] })],
      [
        {
          graphId,
          graphName: Buffer.from('myGraph', 'utf-8'),
          nodeType: [
            {
              nodeTypeId,
              nodeTypeName: Buffer.from('Person', 'utf-8'),
              label: [Buffer.from('Person', 'utf-8')],
            },
          ],
          edgeType: [],
        },
      ],
    );

    const rt = new ResultTable(table);
    const row = rt.next();
    const v = row.getValueByIndex(0);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Node) {
      expect(v.data.graph).toBe('myGraph');
      expect(v.data.type).toBe('Person');
      expect(v.data.labels).toEqual(['Person']);
      expect(v.data.nodeId).toBe(nodeId);
      const age = v.data.properties.get('age');
      expect(age).toBeDefined();
      if (age && !age.isNull && age.type === ColumnType.Int32) {
        expect(age.data).toBe(30);
      }
    }
  });
});
