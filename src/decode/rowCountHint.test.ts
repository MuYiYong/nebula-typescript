import { describe, expect, it } from 'vitest';
import type { NestedVector, VectorResultTable } from '../generated/nebula/vector.js';
import { ColumnType } from '../types/columnType.js';
import { ResultTable } from './resultTable.js';
import './values.js';

function nv(overrides: Partial<NestedVector>): NestedVector {
  return {
    numNestedVectors: 0,
    commonMetaData: { numRecords: 3, vectorContentType: 2 },
    specialMetaData: Buffer.alloc(0),
    vectorData: Buffer.alloc(0),
    nullBitMap: Buffer.alloc(0),
    nestedVectors: [],
    ...overrides,
  };
}

function buildTable(vectorData: Buffer): VectorResultTable {
  return {
    dataLayoutVersion: Buffer.alloc(0),
    meta: {
      tableType: 0,
      numRecords: 3,
      rowType: { numColumns: 1, columnNames: ['n'], columnTypes: [{ valueType: Buffer.from([ColumnType.Int32]) }] },
      numBatches: 1,
      timeZoneOffset: 0,
      isLittleEndian: true,
      graphSchema: [],
    },
    batch: [{ vectors: [nv({ vectorData })] }],
  };
}

describe('ResultTable.rowCountHint()', () => {
  it('reports the row count without consuming the iteration cursor', () => {
    const vectorData = Buffer.alloc(4 * 3);
    vectorData.writeInt32LE(1, 0);
    vectorData.writeInt32LE(2, 4);
    vectorData.writeInt32LE(3, 8);
    const rt = new ResultTable(buildTable(vectorData));

    expect(rt.rowCountHint()).toBe(3);
    // Calling it again should be idempotent (not a one-shot consuming call).
    expect(rt.rowCountHint()).toBe(3);

    // Cursor must still be at the beginning — all 3 rows should be readable.
    const values: number[] = [];
    while (rt.hasNext()) {
      const row = rt.next();
      const v = row.getValueByIndex(0);
      if (!v.isNull && v.type === ColumnType.Int32) values.push(v.data);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('returns 0 for an empty/absent table', () => {
    const rt = new ResultTable(undefined);
    expect(rt.rowCountHint()).toBe(0);
  });
});
