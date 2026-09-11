/**
 * DecodeContext — shared, per-result-table state passed down into every
 * value decode call: the resolved graph schema (for Node/Edge name/label
 * lookup) and the timezone offset (for Zoned* time types).
 * Mirrors nebula-go's `decodeContext` (resultTable.go).
 */

import type { GraphsSchema } from './graphSchema.js';

export interface DecodeContext {
  /** Offset in seconds (converted from VectorTableMetaData.time_zone_offset, which is in minutes). */
  readonly timezoneOffsetSec: number;
  readonly graphsSchema: GraphsSchema;
}
