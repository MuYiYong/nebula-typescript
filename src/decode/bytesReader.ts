/**
 * bytesReader — a minimal sequential byte-buffer cursor used throughout the
 * decoder for both the recursive typeSchema parsing and the various
 * self-describing binary sub-formats (Geography data, Any-composite values).
 *
 * Mirrors nebula-go's `internal/decode.bytesReader` (see findings-go.md
 * section 8.3). All multi-byte reads are little-endian
 * (see DecodingError.OUT_OF_RANGE and the LittleEndian order constant in the
 * reference SDKs).
 */

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export class BytesReader {
  private buf: Buffer;
  private pos: number;

  constructor(buf: Buffer, offset = 0) {
    this.buf = buf;
    this.pos = offset;
  }

  /** Number of bytes remaining. */
  remaining(): number {
    return this.buf.length - this.pos;
  }

  get offset(): number {
    return this.pos;
  }

  /** Reads exactly n bytes and advances the cursor; throws if out of range. */
  readN(n: number): Buffer {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new DecodeError(
        `out of range: cannot read ${n} bytes at offset ${this.pos} (buffer length ${this.buf.length})`,
      );
    }
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readUint8(): number {
    return this.readN(1).readUInt8(0);
  }

  readInt8(): number {
    return this.readN(1).readInt8(0);
  }

  readUint16LE(): number {
    return this.readN(2).readUInt16LE(0);
  }

  readInt16LE(): number {
    return this.readN(2).readInt16LE(0);
  }

  readUint32LE(): number {
    return this.readN(4).readUInt32LE(0);
  }

  readInt32LE(): number {
    return this.readN(4).readInt32LE(0);
  }

  readUint64LE(): bigint {
    return this.readN(8).readBigUInt64LE(0);
  }

  readInt64LE(): bigint {
    return this.readN(8).readBigInt64LE(0);
  }

  readFloat32LE(): number {
    return this.readN(4).readFloatLE(0);
  }

  readFloat64LE(): number {
    return this.readN(8).readDoubleLE(0);
  }

  /** Reads a length-prefixed UTF-8 string: uint16 LE length + bytes. */
  readString16(): string {
    const len = this.readUint16LE();
    return this.readN(len).toString('utf-8');
  }
}

/** Standalone helpers for reading fixed-width values out of an arbitrary
 * Buffer slice at a given offset, without a cursor. Used by the flat-vector
 * decoders which index directly into `vector_data` by row. */
export const bytesToBool = (b: Buffer, offset: number): boolean => b.readUInt8(offset) !== 0;
export const bytesToInt8 = (b: Buffer, offset: number): number => b.readInt8(offset);
export const bytesToUint8 = (b: Buffer, offset: number): number => b.readUInt8(offset);
export const bytesToInt16LE = (b: Buffer, offset: number): number => b.readInt16LE(offset);
export const bytesToUint16LE = (b: Buffer, offset: number): number => b.readUInt16LE(offset);
export const bytesToInt32LE = (b: Buffer, offset: number): number => b.readInt32LE(offset);
export const bytesToUint32LE = (b: Buffer, offset: number): number => b.readUInt32LE(offset);
export const bytesToInt64LE = (b: Buffer, offset: number): bigint => b.readBigInt64LE(offset);
export const bytesToUint64LE = (b: Buffer, offset: number): bigint => b.readBigUInt64LE(offset);
export const bytesToFloat32LE = (b: Buffer, offset: number): number => b.readFloatLE(offset);
export const bytesToFloat64LE = (b: Buffer, offset: number): number => b.readDoubleLE(offset);
