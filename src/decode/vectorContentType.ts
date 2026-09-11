/**
 * vectorContentType — decodes the packed `vector_content_type` field found
 * in VectorCommonMetaData.
 *
 * Layout (see findings-go.md section 5.2):
 *   bits [0..7]  = VectorType (0 Invalid, 1 Const, 2 Flat, 3 Parallel)
 *   bit  8       = nullAllSet (1 = every row in this column is non-null)
 */

export enum VectorType {
  Invalid = 0,
  Const = 1,
  Flat = 2,
  Parallel = 3,
}

export interface VectorContentType {
  readonly vectorType: VectorType;
  readonly nullAllSet: boolean;
}

export function decodeVectorContentType(raw: number): VectorContentType {
  return {
    vectorType: (raw & 0xff) as VectorType,
    nullAllSet: (raw & (1 << 8)) !== 0,
  };
}
