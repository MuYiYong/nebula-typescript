import { describe, expect, it } from 'vitest';
import { BytesReader } from './bytesReader.js';
import { parseTypeSchema } from './typeSchema.js';
import { ColumnType } from '../types/columnType.js';
import { isRowNull } from './nullBitmap.js';
import { decodeVectorContentType, VectorType } from './vectorContentType.js';

describe('typeSchema', () => {
  it('parses a basic Int64 schema', () => {
    const buf = Buffer.from([ColumnType.Int64]);
    const schema = parseTypeSchema(new BytesReader(buf));
    expect(schema.kind).toBe('basic');
    expect(schema.type).toBe(ColumnType.Int64);
  });

  it('parses a List<String> schema', () => {
    const buf = Buffer.from([ColumnType.List, ColumnType.String]);
    const schema = parseTypeSchema(new BytesReader(buf));
    expect(schema.kind).toBe('list');
    if (schema.kind === 'list') {
      expect(schema.sub.type).toBe(ColumnType.String);
    }
  });

  it('parses a Map<String, Int32> schema', () => {
    const buf = Buffer.from([ColumnType.Map, ColumnType.String, ColumnType.Int32]);
    const schema = parseTypeSchema(new BytesReader(buf));
    expect(schema.kind).toBe('map');
    if (schema.kind === 'map') {
      expect(schema.key.type).toBe(ColumnType.String);
      expect(schema.value.type).toBe(ColumnType.Int32);
    }
  });

  it('parses a Record schema with two fields', () => {
    const nameBuf = Buffer.from('a', 'utf-8');
    const buf = Buffer.concat([
      Buffer.from([ColumnType.Record]),
      Buffer.from([2, 0, 0, 0]), // numFields = 2 (int32 LE)
      Buffer.from([1, 0]), // nameLen = 1 (int16 LE)
      nameBuf,
      Buffer.from([ColumnType.Bool]),
      Buffer.from([1, 0]),
      Buffer.from('b', 'utf-8'),
      Buffer.from([ColumnType.Float64]),
    ]);
    const schema = parseTypeSchema(new BytesReader(buf));
    expect(schema.kind).toBe('record');
    if (schema.kind === 'record') {
      expect(schema.props.get('a')?.type).toBe(ColumnType.Bool);
      expect(schema.props.get('b')?.type).toBe(ColumnType.Float64);
    }
  });

  it('parses an embedding Vector schema', () => {
    const buf = Buffer.concat([
      Buffer.from([ColumnType.Vector]),
      Buffer.from([4, 0, 0, 0]), // dim = 4
      Buffer.from([ColumnType.Float32]),
    ]);
    const schema = parseTypeSchema(new BytesReader(buf));
    expect(schema.kind).toBe('vector');
    if (schema.kind === 'vector') {
      expect(schema.dim).toBe(4);
      expect(schema.sub.type).toBe(ColumnType.Float32);
    }
  });

  it('throws on unknown type code', () => {
    const buf = Buffer.from([0x99]);
    expect(() => parseTypeSchema(new BytesReader(buf))).toThrow();
  });
});

describe('BytesReader', () => {
  it('reads little-endian fixed-width values', () => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(123456789n, 0);
    const r = new BytesReader(buf);
    expect(r.readInt64LE()).toBe(123456789n);
  });

  it('throws when reading past the end', () => {
    const r = new BytesReader(Buffer.from([1, 2]));
    expect(() => r.readN(3)).toThrow();
  });
});

describe('nullBitmap', () => {
  it('treats missing bitmap as all-non-null', () => {
    expect(isRowNull(undefined, 0)).toBe(false);
    expect(isRowNull(Buffer.alloc(0), 5)).toBe(false);
  });

  it('reads bit=1 as non-null, bit=0 as null, LSB first', () => {
    // byte 0b00000101 -> row0=nonnull, row1=null, row2=nonnull, row3..7=null
    const bm = Buffer.from([0b00000101]);
    expect(isRowNull(bm, 0)).toBe(false);
    expect(isRowNull(bm, 1)).toBe(true);
    expect(isRowNull(bm, 2)).toBe(false);
    expect(isRowNull(bm, 3)).toBe(true);
  });
});

describe('vectorContentType', () => {
  it('decodes vectorType and nullAllSet bit', () => {
    expect(decodeVectorContentType(2)).toEqual({ vectorType: VectorType.Flat, nullAllSet: false });
    expect(decodeVectorContentType(1)).toEqual({ vectorType: VectorType.Const, nullAllSet: false });
    expect(decodeVectorContentType(2 | (1 << 8))).toEqual({
      vectorType: VectorType.Flat,
      nullAllSet: true,
    });
  });
});
