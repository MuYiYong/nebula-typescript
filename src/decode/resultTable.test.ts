import { describe, expect, it } from 'vitest';
import type { NestedVector, VectorResultTable } from '../generated/nebula/vector.js';
import { ColumnType } from '../types/columnType.js';
import { ResultTable } from './resultTable.js';
import './values.js';

function nv(overrides: Partial<NestedVector>): NestedVector {
  return {
    numNestedVectors: 0,
    commonMetaData: { numRecords: 1, vectorContentType: 2 /* Flat */ },
    specialMetaData: Buffer.alloc(0),
    vectorData: Buffer.alloc(0),
    nullBitMap: Buffer.alloc(0),
    nestedVectors: [],
    ...overrides,
  };
}

function typeBytes(code: ColumnType): Buffer {
  return Buffer.from([code]);
}

function buildTable(columnNames: string[], columnTypes: Buffer[], vectors: NestedVector[]): VectorResultTable {
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
      graphSchema: [],
    },
    batch: [{ vectors }],
  };
}

describe('ResultTable end-to-end decoding', () => {
  it('decodes a basic Int64 + Bool row', () => {
    const int64Data = Buffer.alloc(8);
    int64Data.writeBigInt64LE(42n, 0);
    const boolData = Buffer.from([1]);

    const table = buildTable(
      ['id', 'flag'],
      [typeBytes(ColumnType.Int64), typeBytes(ColumnType.Bool)],
      [nv({ vectorData: int64Data }), nv({ vectorData: boolData })],
    );

    const rt = new ResultTable(table);
    expect(rt.hasNext()).toBe(true);
    const row = rt.next();
    const id = row.getValueByName('id');
    const flag = row.getValueByName('flag');
    expect(id.isNull).toBe(false);
    if (!id.isNull && id.type === ColumnType.Int64) expect(id.data).toBe(42n);
    if (!flag.isNull && flag.type === ColumnType.Bool) expect(flag.data).toBe(true);
    expect(rt.hasNext()).toBe(false);
  });

  it('decodes a NULL value via null_bit_map', () => {
    const int32Data = Buffer.alloc(4);
    int32Data.writeInt32LE(99, 0);
    const table = buildTable(
      ['n'],
      [typeBytes(ColumnType.Int32)],
      [nv({ vectorData: int32Data, nullBitMap: Buffer.from([0b0]) })],
    );
    const rt = new ResultTable(table);
    const row = rt.next();
    const v = row.getValueByIndex(0);
    expect(v.isNull).toBe(true);
  });

  it('decodes an inline short String (<=12 bytes)', () => {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(5, 0); // length
    header.write('hello', 4, 'utf-8'); // prefix (inline)
    const table = buildTable(
      ['s'],
      [typeBytes(ColumnType.String)],
      [nv({ vectorData: header })],
    );
    const rt = new ResultTable(table);
    const row = rt.next();
    const v = row.getValueByIndex(0);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.String) expect(v.data).toBe('hello');
  });

  it('decodes a chunked long String (>12 bytes)', () => {
    const longStr = 'this is a longer string exceeding twelve bytes';
    const chunk = nv({ vectorData: Buffer.from(longStr, 'utf-8') });
    const header = Buffer.alloc(16);
    header.writeUInt32LE(longStr.length, 0); // length
    header.writeUInt32LE(0, 8); // chunkOffset
    header.writeUInt32LE(0, 12); // chunkIndex
    const table = buildTable(
      ['s'],
      [typeBytes(ColumnType.String)],
      [nv({ vectorData: header, nestedVectors: [chunk] })],
    );
    const rt = new ResultTable(table);
    const row = rt.next();
    const v = row.getValueByIndex(0);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.String) expect(v.data).toBe(longStr);
  });

  it('decodes a List<Int32>', () => {
    const elementVector = nv({ vectorData: Buffer.alloc(4 * 3) });
    elementVector.vectorData.writeInt32LE(10, 0);
    elementVector.vectorData.writeInt32LE(20, 4);
    elementVector.vectorData.writeInt32LE(30, 8);

    const header = Buffer.alloc(8);
    header.writeUInt32LE(0, 0); // offset
    header.writeUInt32LE(3, 4); // size

    const listSchema = Buffer.concat([typeBytes(ColumnType.List), typeBytes(ColumnType.Int32)]);
    const table = buildTable(
      ['xs'],
      [listSchema],
      [nv({ vectorData: header, nestedVectors: [elementVector] })],
    );
    const rt = new ResultTable(table);
    const row = rt.next();
    const v = row.getValueByIndex(0);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.List) {
      const nums = v.data.values.map((val) => (!val.isNull && val.type === ColumnType.Int32 ? val.data : null));
      expect(nums).toEqual([10, 20, 30]);
    }
  });

  it('decodes an embedding Vector', () => {
    const dim = 3;
    const vectorData = Buffer.alloc(dim * 4);
    vectorData.writeFloatLE(1.5, 0);
    vectorData.writeFloatLE(2.5, 4);
    vectorData.writeFloatLE(3.5, 8);
    const schema = Buffer.concat([
      typeBytes(ColumnType.Vector),
      Buffer.from([dim, 0, 0, 0]),
      typeBytes(ColumnType.Float32),
    ]);
    const table = buildTable(['emb'], [schema], [nv({ vectorData })]);
    const rt = new ResultTable(table);
    const row = rt.next();
    const v = row.getValueByIndex(0);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Vector) {
      expect(v.data.values[0]).toBeCloseTo(1.5, 5);
      expect(v.data.values[1]).toBeCloseTo(2.5, 5);
      expect(v.data.values[2]).toBeCloseTo(3.5, 5);
    }
  });

  it('handles an empty/absent table', () => {
    const rt = new ResultTable(undefined);
    expect(rt.hasNext()).toBe(false);
    expect(rt.columnNames).toEqual([]);
  });
});
