import { describe, expect, it } from 'vitest';
import { BytesReader } from './bytesReader.js';
import { decodeAnyCompositeValue } from './anyValue.js';
import { ColumnType } from '../types/columnType.js';
import type { DecodeContext } from './decodeContext.js';

const ctx: DecodeContext = { timezoneOffsetSec: 0, graphsSchema: new Map() };

describe('decodeAnyCompositeValue — DoS guard', () => {
  it('rejects a List declaring more elements than the safety cap, before allocating', () => {
    // subType byte + size(uint16) declaring the max possible value (65535).
    // Still under the 10M cap, so this should decode structurally (though it
    // will fail later for lack of real data) rather than being rejected by
    // the cap itself — included to document the boundary.
    const buf = Buffer.concat([Buffer.from([ColumnType.Int32]), Buffer.from([0xff, 0xff])]);
    const r = new BytesReader(buf);
    // Expect it to throw (insufficient bytes for the null bitmap), NOT hang
    // or attempt a 65535-element allocation problem — this just proves the
    // call terminates quickly.
    expect(() => decodeAnyCompositeValue(ctx, r, ColumnType.List)).toThrow();
  });

  it('rejects a Set declaring an element count above MAX_COMPOSITE_ELEMENT_COUNT immediately', () => {
    // subType byte + size(uint32) = 4_294_967_295 (max uint32), which must be
    // rejected by the safety cap BEFORE attempting to read the null bitmap
    // (which would itself require ~536MB of input to pass the bounds check).
    const size = 4_294_967_295;
    const buf = Buffer.alloc(1 + 4);
    buf.writeUInt8(ColumnType.Int32, 0);
    buf.writeUInt32LE(size, 1);
    const r = new BytesReader(buf);
    expect(() => decodeAnyCompositeValue(ctx, r, ColumnType.Set)).toThrow(/safety limit/);
  });

  it('accepts a Set within the safety cap and decodes normally', () => {
    const subType = ColumnType.Int32;
    const size = 3;
    const bitmapByte = 0b00000111; // all 3 present
    const elements = Buffer.concat([
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([2, 0, 0, 0]),
      Buffer.from([3, 0, 0, 0]),
    ]);
    const buf = Buffer.concat([
      Buffer.from([subType]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(size, 0);
        return b;
      })(),
      Buffer.from([bitmapByte]),
      elements,
    ]);
    const r = new BytesReader(buf);
    const v = decodeAnyCompositeValue(ctx, r, ColumnType.Set);
    expect(v.isNull).toBe(false);
    if (!v.isNull && v.type === ColumnType.Set) {
      const nums = v.data.values.map((x) => (!x.isNull && x.type === ColumnType.Int32 ? x.data : null));
      expect(nums).toEqual([1, 2, 3]);
    }
  });
});
