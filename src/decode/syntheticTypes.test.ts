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

function typeBytes(...codes: number[]): Buffer {
  return Buffer.from(codes);
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}
function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function int64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n, 0);
  return b;
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

function decodeSingle(columnType: Buffer, vector: NestedVector, graphSchema: VectorResultTable['meta'] extends infer M ? (M extends { graphSchema: infer G } ? G : never) : never = []) {
  const table = buildTable(['v'], [columnType], [vector], graphSchema);
  const rt = new ResultTable(table);
  const row = rt.next();
  return row.getValueByIndex(0);
}

describe('Set decoding', () => {
  it('decodes a Set<Int32>', () => {
    const elementVector = nv({ vectorData: Buffer.concat([int32(1), int32(2), int32(3)]) });
    const header = Buffer.concat([uint32(0), uint32(3)]); // offset=0, size=3
    const v = decodeSingle(
      typeBytes(ColumnType.Set, ColumnType.Int32),
      nv({ vectorData: header, nestedVectors: [elementVector] }),
    );
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Set) {
      const nums = v.data.values.map((x) => (!x.isNull && x.type === ColumnType.Int32 ? x.data : null));
      expect(nums.sort()).toEqual([1, 2, 3]);
    }
  });
});

describe('Map decoding (column-level, not literal)', () => {
  it('decodes a Map<String, Int32>', () => {
    const keyHeaderA = Buffer.alloc(16);
    keyHeaderA.writeUInt32LE(1, 0); // length=1
    keyHeaderA.write('a', 4, 'utf-8');
    const keyHeaderB = Buffer.alloc(16);
    keyHeaderB.writeUInt32LE(1, 0);
    keyHeaderB.write('b', 4, 'utf-8');
    const keyVector = nv({ vectorData: Buffer.concat([keyHeaderA, keyHeaderB]) });
    const valueVector = nv({ vectorData: Buffer.concat([int32(10), int32(20)]) });
    const header = Buffer.concat([uint32(0), uint32(2)]);
    const v = decodeSingle(
      typeBytes(ColumnType.Map, ColumnType.String, ColumnType.Int32),
      nv({ vectorData: header, nestedVectors: [keyVector, valueVector] }),
    );
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Map) {
      const entries = Array.from(v.data.entries.entries()).map(([k, val]) => [
        !k.isNull && k.type === ColumnType.String ? k.data : null,
        !val.isNull && val.type === ColumnType.Int32 ? val.data : null,
      ]);
      expect(entries).toEqual([
        ['a', 10],
        ['b', 20],
      ]);
    }
  });
});

describe('Duration decoding', () => {
  it('decodes a day-based Duration', () => {
    // isMonthBased=false (bit0=0); value = days*DAY_US + hours*HOUR_US + ...
    const DAY_US = 24n * 60n * 60n * 1_000_000n;
    const raw = (2n * DAY_US) << 1n; // 2 days, isMonthBased bit = 0
    const v = decodeSingle(typeBytes(ColumnType.Duration), nv({ vectorData: int64(raw) }));
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Duration) {
      expect(v.data.isMonthBased).toBe(false);
      expect(v.data.day).toBe(2);
    }
  });

  it('decodes a month-based Duration', () => {
    const value = 14n; // 1 year 2 months
    const raw = (value << 1n) | 1n; // isMonthBased bit = 1
    const v = decodeSingle(typeBytes(ColumnType.Duration), nv({ vectorData: int64(raw) }));
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Duration) {
      expect(v.data.isMonthBased).toBe(true);
      expect(v.data.year).toBe(1);
      expect(v.data.month).toBe(2);
    }
  });
});

describe('Geography decoding', () => {
  it('decodes a Point', () => {
    const body = Buffer.alloc(1 + 4 + 8 + 8);
    body.writeInt8(0, 0); // PointP shape
    body.writeInt32LE(4326, 1); // srid
    body.writeDoubleLE(1.5, 5); // lng
    body.writeDoubleLE(2.5, 13); // lat
    const chunk = nv({ vectorData: body });
    const header = Buffer.concat([uint32(0), int32(0)]); // chunkIndex=0, chunkOffset=0
    const v = decodeSingle(typeBytes(ColumnType.Geography), nv({ vectorData: header, nestedVectors: [chunk] }));
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Geography) {
      expect(v.data.point?.lng).toBeCloseTo(1.5, 5);
      expect(v.data.point?.lat).toBeCloseTo(2.5, 5);
      expect(v.data.srid).toBe(4326);
    }
  });
});

describe('Const vector decoding', () => {
  it('decodes a Const Int32 column (same value for every row)', () => {
    const table = buildTable(
      ['c'],
      [typeBytes(ColumnType.Int32)],
      [nv({ vectorData: int32(42), commonMetaData: { numRecords: 3, vectorContentType: 1 /* Const */ } })],
    );
    const rt = new ResultTable(table);
    const values: unknown[] = [];
    while (rt.hasNext()) {
      const row = rt.next();
      const v = row.getValueByIndex(0);
      values.push(!v.isNull && v.type === ColumnType.Int32 ? v.data : null);
    }
    expect(values).toEqual([42, 42, 42]);
  });
});

describe('ZonedTime decoding', () => {
  it('decodes a ZonedTime with a positive offset', () => {
    const bs = Buffer.alloc(8);
    bs.writeInt8(10, 0); // hour
    bs.writeInt8(30, 1); // minute
    bs.writeInt8(0, 2); // sec
    bs.writeInt32LE(0, 4); // microsec
    const table = buildTable(['t'], [typeBytes(ColumnType.ZonedTime)], [nv({ vectorData: bs })]);
    // timeZoneOffset is in minutes in the wire meta; use a table builder with offset.
    const tableWithOffset: VectorResultTable = {
      ...table,
      meta: { ...table.meta!, timeZoneOffset: 60 }, // +60 minutes = +1 hour
    };
    const rt = new ResultTable(tableWithOffset);
    const row = rt.next();
    const v = row.getValueByIndex(0);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.ZonedTime) {
      expect(v.data.hour).toBe(11); // shifted by +1 hour
      expect(v.data.offset).toBe(3600);
    }
  });
});

describe('Any composite decoding', () => {
  it('decodes an Any column holding a basic Int32 value', () => {
    const typeVector = nv({ vectorData: Buffer.from([ColumnType.Int32]) });
    const dataVector = nv({
      vectorData: Buffer.concat([int32(777), Buffer.alloc(4)]), // 8-byte inline slot
      nestedVectors: [typeVector],
    });
    const v = decodeSingle(typeBytes(ColumnType.Any), dataVector);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Int32) {
      expect(v.data).toBe(777);
    }
  });
});
