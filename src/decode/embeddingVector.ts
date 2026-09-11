/**
 * decodeVectorFlatValue — embedding vector flat decoder. vector_data is a
 * flat, contiguous float32[] array; row i occupies [i*dim*4, i*dim*4+dim*4).
 * See findings-go.md section 5.9.
 */
import type { NebulaEmbeddingVector } from '../types/value.js';

export function decodeVectorFlatValue(vectorData: Buffer, dim: number, rowIndex: number): NebulaEmbeddingVector {
  const offset = rowIndex * dim * 4;
  const values: number[] = [];
  for (let i = 0; i < dim; i++) {
    values.push(vectorData.readFloatLE(offset + i * 4));
  }
  return { values };
}
