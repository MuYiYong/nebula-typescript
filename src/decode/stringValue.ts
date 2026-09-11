/**
 * Flat-vector decoders for String/Decimal (chunked, prefix-inlined) values.
 * Layout: 16-byte header per row = length(4B) + prefix(4B) + chunkOffset(4B)
 * + chunkIndex(4B). If length <= 12, the value is inlined in the prefix
 * bytes; otherwise it lives at nested_vectors[chunkIndex].vector_data
 * [chunkOffset : chunkOffset+length]. See findings-go.md section 5.8.
 */

import { bytesToUint32LE } from './bytesReader.js';
import { ColumnType } from '../types/columnType.js';
import type { NestedVector } from '../generated/nebula/vector.js';
import type { NebulaValueOrNull } from '../types/value.js';

const HEADER_LEN = 16;
const INLINE_THRESHOLD = 12;

function readHeader(vectorData: Buffer, rowIndex: number): Buffer {
  return vectorData.subarray(rowIndex * HEADER_LEN, rowIndex * HEADER_LEN + HEADER_LEN);
}

export function decodeStringFlatValue(v: NestedVector, rowIndex: number): NebulaValueOrNull {
  const header = readHeader(v.vectorData, rowIndex);
  const strLen = bytesToUint32LE(header, 0);
  if (strLen <= INLINE_THRESHOLD) {
    const data = header.subarray(4, 4 + strLen).toString('utf-8');
    return { type: ColumnType.String, isNull: false, data };
  }
  const chunkOffset = bytesToUint32LE(header, 8);
  const chunkIndex = bytesToUint32LE(header, 12);
  const chunk = v.nestedVectors[chunkIndex];
  if (!chunk) {
    throw new Error(`String value: missing nested vector chunk at index ${chunkIndex}`);
  }
  const data = chunk.vectorData.subarray(chunkOffset, chunkOffset + strLen).toString('utf-8');
  return { type: ColumnType.String, isNull: false, data };
}

export function decodeDecimalFlatValue(v: NestedVector, rowIndex: number): NebulaValueOrNull {
  const header = readHeader(v.vectorData, rowIndex);
  const strLen = bytesToUint32LE(header, 0);
  if (strLen <= INLINE_THRESHOLD) {
    const sval = header.subarray(4, 4 + strLen).toString('utf-8');
    return { type: ColumnType.Decimal, isNull: false, data: { sval } };
  }
  const chunkOffset = bytesToUint32LE(header, 8);
  const chunkIndex = bytesToUint32LE(header, 12);
  const chunk = v.nestedVectors[chunkIndex];
  if (!chunk) {
    throw new Error(`Decimal value: missing nested vector chunk at index ${chunkIndex}`);
  }
  const sval = chunk.vectorData.subarray(chunkOffset, chunkOffset + strLen).toString('utf-8');
  return { type: ColumnType.Decimal, isNull: false, data: { sval } };
}
