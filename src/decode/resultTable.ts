/**
 * ResultTable — top-level decoder entry point. Parses a VectorResultTable
 * into column schemas + per-batch VectorWrapper columns, and exposes
 * iteration over decoded rows. Mirrors nebula-go's `ResultTable`
 * (resultTable.go) / nebula-python's `ResultTable` (result_set.py).
 */

import type { VectorResultTable } from '../generated/nebula/vector.js';
import { ColumnType } from '../types/columnType.js';
import { nullValue, toPrimitive, type NebulaValueOrNull } from '../types/value.js';
import { BytesReader } from './bytesReader.js';
import type { DecodeContext } from './decodeContext.js';
import { constructGraphsSchema } from './graphSchema.js';
import { parseTypeSchema, type TypeSchema } from './typeSchema.js';
import { VectorWrapper } from './vectorWrapper.js';
// Ensures the concrete per-type decoders are registered with VectorWrapper
// (registerValueDecoder / registerElementValueDecoder / etc.) before any
// ResultTable is constructed, regardless of which module first imports
// ResultTable.
import './values.js';

export class BatchCountMismatchError extends Error {
  constructor(expected: number, actual: number) {
    super(
      `VectorResultTable.meta.numBatches (${expected}) does not match batch array length (${actual})`,
    );
    this.name = 'BatchCountMismatchError';
  }
}

class RowBatch {
  constructor(readonly columns: readonly VectorWrapper[]) {}

  numRecords(): number {
    const first = this.columns[0];
    return first ? first.numRecords() : 0;
  }

  getRowByIndex(rowIndex: number): NebulaValueOrNull[] {
    if (rowIndex >= this.numRecords()) {
      throw new RangeError(`row index ${rowIndex} out of range (numRecords=${this.numRecords()})`);
    }
    return this.columns.map((col) => col.decodeValue(rowIndex));
  }
}

export class ResultTableRow {
  constructor(
    private readonly columnNames: readonly string[],
    private readonly rowValues: readonly NebulaValueOrNull[],
  ) {}

  values(): readonly NebulaValueOrNull[] {
    return this.rowValues;
  }

  getValueByIndex(index: number): NebulaValueOrNull {
    const v = this.rowValues[index];
    if (v === undefined) {
      throw new RangeError(`column index out of range: ${index}`);
    }
    return v;
  }

  getValueByName(name: string): NebulaValueOrNull {
    const idx = this.columnNames.indexOf(name);
    if (idx < 0) {
      throw new Error(`column not found: ${name}`);
    }
    return this.getValueByIndex(idx);
  }

  toPrimitive(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < this.columnNames.length; i++) {
      const name = this.columnNames[i];
      if (name === undefined) continue;
      out[name] = toPrimitive(this.rowValues[i]!);
    }
    return out;
  }
}

/**
 * Decoded, iterable view over a VectorResultTable's rows.
 * Empty/absent tables (table === undefined or table.meta === undefined)
 * decode to a ResultTable with zero rows and zero columns.
 */
export class ResultTable {
  readonly columnNames: readonly string[];
  readonly columnTypeSchemas: readonly TypeSchema[];

  private readonly batches: readonly RowBatch[];
  private readonly numBatches: number;
  private batchIndex = 0;
  private currentBatch: RowBatch | undefined;
  private currentBatchRowIndex = 0;

  constructor(table: VectorResultTable | undefined) {
    if (!table || !table.meta) {
      this.columnNames = [];
      this.columnTypeSchemas = [];
      this.batches = [];
      this.numBatches = 0;
      return;
    }

    const meta = table.meta;
    if (table.batch.length > 0 && meta.numBatches !== table.batch.length) {
      throw new BatchCountMismatchError(meta.numBatches, table.batch.length);
    }

    const graphsSchema = constructGraphsSchema(meta.graphSchema);
    const ctx: DecodeContext = {
      timezoneOffsetSec: meta.timeZoneOffset * 60,
      graphsSchema,
    };

    const columnNames: string[] = [];
    const columnTypeSchemas: TypeSchema[] = [];
    if (meta.rowType) {
      columnNames.push(...meta.rowType.columnNames);
      for (const ct of meta.rowType.columnTypes) {
        const r = new BytesReader(ct.valueType);
        columnTypeSchemas.push(parseTypeSchema(r));
      }
    }
    this.columnNames = columnNames;
    this.columnTypeSchemas = columnTypeSchemas;

    this.numBatches = table.batch.length;
    const batches: RowBatch[] = [];
    for (const vectorBatch of table.batch) {
      const columns = vectorBatch.vectors.map((nested, colIndex) => {
        const schema = columnTypeSchemas[colIndex];
        if (!schema) {
          throw new Error(`missing column type schema for column index ${colIndex}`);
        }
        return new VectorWrapper(nested, schema, ctx);
      });
      batches.push(new RowBatch(columns));
    }
    this.batches = batches;
  }

  columnTypes(): readonly ColumnType[] {
    return this.columnTypeSchemas.map((s) => s.type);
  }

  /** Total row count across all batches, computed in O(numBatches) without
   * consuming the iteration cursor (unlike iterating to completion). Safe to
   * call before, during, or after iterating with next()/hasNext(). */
  rowCountHint(): number {
    let total = 0;
    for (const batch of this.batches) {
      total += batch.numRecords();
    }
    return total;
  }

  private advanceToNonEmptyBatch(): boolean {
    for (;;) {
      if (this.batches.length === 0 || this.batchIndex >= this.numBatches) {
        return false;
      }
      if (!this.currentBatch) {
        this.currentBatch = this.batches[this.batchIndex];
      }
      if (this.currentBatch && this.currentBatchRowIndex < this.currentBatch.numRecords()) {
        return true;
      }
      this.batchIndex++;
      this.currentBatchRowIndex = 0;
      this.currentBatch = undefined;
    }
  }

  hasNext(): boolean {
    return this.advanceToNonEmptyBatch();
  }

  next(): ResultTableRow {
    if (!this.advanceToNonEmptyBatch() || !this.currentBatch) {
      throw new RangeError('no more rows');
    }
    const rowValues = this.currentBatch.getRowByIndex(this.currentBatchRowIndex);
    this.currentBatchRowIndex++;
    return new ResultTableRow(this.columnNames, rowValues);
  }

  *[Symbol.iterator](): IterableIterator<ResultTableRow> {
    while (this.hasNext()) {
      yield this.next();
    }
  }
}

export { nullValue };
