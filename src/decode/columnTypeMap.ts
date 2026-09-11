/**
 * columnTypeMap — maps the raw wire byte code (first byte of an encoded
 * column type / typeSchema) to the ColumnType enum.
 *
 * Since ColumnType's numeric values already equal the wire byte codes
 * (see types/columnType.ts), this is effectively an identity + validity
 * check, mirroring nebula-go's `columnTypeMap` in internal/decode/columnType.go.
 */
import { ColumnType } from '../types/columnType.js';

const VALID_COLUMN_TYPE_CODES: ReadonlySet<number> = new Set(
  Object.values(ColumnType).filter((v): v is number => typeof v === 'number'),
);

export function lookupColumnType(code: number): ColumnType {
  if (!VALID_COLUMN_TYPE_CODES.has(code)) {
    throw new Error(`unknown column type code: 0x${code.toString(16)}`);
  }
  return code as ColumnType;
}
