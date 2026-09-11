/**
 * nullBitmap — helpers for the per-column null bitmap embedded in
 * NestedVector.null_bit_map.
 *
 * Layout: 1 bit per row, LSB-first within each byte; bit=1 means the value
 * is present (non-NULL), bit=0 means NULL. See findings-go.md section 5.5.
 */

export function isRowNull(nullBitMap: Buffer | undefined, rowIndex: number): boolean {
  if (!nullBitMap || nullBitMap.length === 0) {
    // No bitmap present means the column's `nullAllSet` flag was set:
    // every row is non-null.
    return false;
  }
  const byteIndex = Math.floor(rowIndex / 8);
  const bitIndex = rowIndex % 8;
  if (byteIndex >= nullBitMap.length) {
    return false;
  }
  const byte = nullBitMap[byteIndex]!;
  return (byte & (1 << bitIndex)) === 0;
}
