/**
 * High-level result/session interfaces, mirroring the reference SDKs'
 * `pkg/types.{Client,Pool,Result,Table,Row,Summary,PlanInfo,QueryStats}`
 * (see findings-go.md section 0 and findings-python.md ResultSet/Record).
 */

import type { ColumnType } from './columnType.js';
import type { NebulaValueOrNull } from './value.js';

export interface Row {
  values(): readonly NebulaValueOrNull[];
  getValueByName(name: string): NebulaValueOrNull;
  getValueByIndex(index: number): NebulaValueOrNull;
  /** Convert the row to a plain object keyed by column name (primitives). */
  toPrimitive(): Record<string, unknown>;
}

export interface PlanInfo {
  readonly id: string;
  readonly name: string;
  readonly details: string;
  readonly columns: readonly string[];
  readonly timeMs: number;
  readonly rows: bigint;
  readonly memoryKib: number;
  readonly blockedMs: number;
  readonly queuedMs: number;
  readonly consumeMs: number;
  readonly produceMs: number;
  readonly finishMs: number;
  readonly batches: bigint;
  readonly concurrency: bigint;
  readonly otherStatsJson: string;
  readonly children: readonly PlanInfo[];
}

export interface QueryStats {
  readonly numAffectedNodes: bigint;
  readonly numAffectedEdges: bigint;
  readonly exportedPaths: readonly string[];
  readonly numExportedRecords: bigint;
}

export interface ElapsedTime {
  readonly totalServerTimeUs: bigint;
  readonly buildTimeUs: bigint;
  readonly optimizeTimeUs: bigint;
  readonly serializeTimeUs: bigint;
  readonly parseTimeUs: bigint;
}

export interface Summary {
  readonly elapsedTime: ElapsedTime;
  readonly explainType: string;
  readonly planInfo: PlanInfo | undefined;
  readonly queryStats: QueryStats | undefined;
  readonly logStream: string;
  readonly numWarnings: number;
}

/** A decoded query result table (possibly spanning multiple wire-level batches). */
export interface Table {
  rowSize(): number;
  hasNext(): boolean;
  next(): Row;
  columns(): readonly string[];
  columnTypes(): readonly ColumnType[];
  /** Iterate over all remaining rows. */
  [Symbol.iterator](): IterableIterator<Row>;
}

/** The full result of an Execute call: status + decoded table + summary + cursor. */
export interface ExecutionResult extends Table {
  readonly isSucceeded: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly latencyUs: number;
  readonly summary: Summary | undefined;
  readonly cursor: Buffer;
  /** Throws NebulaGraphRemoteError if the query failed. */
  raiseOnError(): void;
}
