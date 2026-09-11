/**
 * VectorWrapper — wraps one column's wire-level NestedVector together with
 * its resolved TypeSchema, and exposes `decodeValue(rowIndex)` used by
 * Batch.getRowByIndex(). Mirrors nebula-go's `vectorWrapper`
 * (resultTable.go) and its `prepare()` / `decodeValue()` methods.
 *
 * Per-column preparation (lazy, cached):
 *  - Node/Edge columns: resolve the property-name -> nested_vectors[i] index
 *    mapping from `special_meta_data`.
 *  - Path columns: resolve the pairIndex -> {cur, adj} NestedVector mapping.
 *
 * Dispatch by VectorType:
 *  - Const: decode once, cache the result, and return the cached value for
 *    every row index.
 *  - Flat: decode independently per row index (the common case).
 */

import type { NestedVector } from '../generated/nebula/vector.js';
import { ColumnType } from '../types/columnType.js';
import type { NebulaValueOrNull } from '../types/value.js';
import { nullValue } from '../types/value.js';
import type { DecodeContext } from './decodeContext.js';
import { decodePathSpecialData, type PathMetaData } from './pathMeta.js';
import { decodePropVectorIndex, type PropVectorIndex } from './propVectorIndex.js';
import type { GraphElementPropsByGraph, TypeSchema } from './typeSchema.js';
import { decodeVectorContentType, VectorType } from './vectorContentType.js';

export { VectorType };

/** Signature implemented by decode/values.ts per-type decode functions. */
export type DecodeValueFn = (
  ctx: DecodeContext,
  vector: NestedVector,
  vectorType: VectorType,
  rowIndex: number,
  schema: TypeSchema,
) => NebulaValueOrNull;

/** Injected by decode/values.ts to avoid a circular import; see registerValueDecoder(). */
let decodeValueImpl: DecodeValueFn | undefined;

export function registerValueDecoder(fn: DecodeValueFn): void {
  decodeValueImpl = fn;
}

/** Node/Edge decoding needs the property-vector-index resolved by
 * VectorWrapper.prepare(), which a bare TypeSchema cannot express. */
export type DecodeElementValueFn = (
  ctx: DecodeContext,
  vector: NestedVector,
  rowIndex: number,
  isNode: boolean,
  propVectorIndex: PropVectorIndex,
  schema: Extract<TypeSchema, { kind: 'element' }>,
) => NebulaValueOrNull;

let decodeElementValueImpl: DecodeElementValueFn | undefined;

export function registerElementValueDecoder(fn: DecodeElementValueFn): void {
  decodeElementValueImpl = fn;
}

/** Path decoding needs the pair metadata resolved by VectorWrapper.prepare(). */
export type DecodePathValueFn = (
  ctx: DecodeContext,
  vector: NestedVector,
  rowIndex: number,
  meta: PathMetaData,
  nodeGraphElementProps: GraphElementPropsByGraph,
  edgeGraphElementProps: GraphElementPropsByGraph,
) => NebulaValueOrNull;

let decodePathValueImpl: DecodePathValueFn | undefined;

export function registerPathValueDecoder(fn: DecodePathValueFn): void {
  decodePathValueImpl = fn;
}

/** Any-typed columns carry their own type tag per row and are decoded via a
 * dedicated entry point rather than the generic schema-driven dispatcher. */
export type DecodeAnyValueFn = (
  ctx: DecodeContext,
  vector: NestedVector,
  rowIndex: number,
) => NebulaValueOrNull;

let decodeAnyValueImpl: DecodeAnyValueFn | undefined;

export function registerAnyValueDecoder(fn: DecodeAnyValueFn): void {
  decodeAnyValueImpl = fn;
}

export class VectorWrapper {
  readonly vector: NestedVector;
  readonly schema: TypeSchema;
  readonly vectorType: VectorType;
  readonly nullAllSet: boolean;
  private readonly ctx: DecodeContext;

  private prepared = false;
  private propVectorIndex: PropVectorIndex | undefined;
  private pathMeta: PathMetaData | undefined;
  private constValue: NebulaValueOrNull | undefined;

  constructor(vector: NestedVector, schema: TypeSchema, ctx: DecodeContext) {
    this.vector = vector;
    this.schema = schema;
    this.ctx = ctx;

    if (schema.type === ColumnType.Unknown) {
      this.vectorType = VectorType.Invalid;
      this.nullAllSet = false;
    } else {
      const raw = vector.commonMetaData?.vectorContentType ?? 0;
      const decoded = decodeVectorContentType(raw);
      this.vectorType = decoded.vectorType;
      this.nullAllSet = decoded.nullAllSet;
    }
  }

  numRecords(): number {
    return this.vector.commonMetaData?.numRecords ?? 0;
  }

  /** Lazily resolves Node/Edge property indices or Path pair metadata. */
  private prepare(): void {
    if (this.vectorType !== VectorType.Flat || this.prepared) {
      return;
    }
    switch (this.schema.type) {
      case ColumnType.Node:
      case ColumnType.Edge: {
        if (this.schema.kind !== 'element') break;
        const isNode = this.schema.type === ColumnType.Node;
        this.propVectorIndex = decodePropVectorIndex(
          this.vector.specialMetaData,
          this.schema.graphElementProps,
          isNode,
        );
        break;
      }
      case ColumnType.Path: {
        this.pathMeta = decodePathSpecialData(this.vector);
        break;
      }
      default:
        break;
    }
    this.prepared = true;
  }

  getPropVectorIndex(): PropVectorIndex {
    this.prepare();
    if (!this.propVectorIndex) {
      throw new Error('property vector index not prepared for this column');
    }
    return this.propVectorIndex;
  }

  getPathMeta(): PathMetaData {
    this.prepare();
    if (!this.pathMeta) {
      throw new Error('path metadata not prepared for this column');
    }
    return this.pathMeta;
  }

  getElementProps(): GraphElementPropsByGraph {
    if (this.schema.kind !== 'element') {
      throw new Error('schema is not an element (Node/Edge) schema');
    }
    return this.schema.graphElementProps;
  }

  decodeValue(rowIndex: number): NebulaValueOrNull {
    if (this.schema.type === ColumnType.Unknown) {
      return nullValue(ColumnType.Unknown);
    }
    if (this.vectorType === VectorType.Const && this.constValue !== undefined) {
      return this.constValue;
    }
    this.prepare();

    let value: NebulaValueOrNull;
    if (this.vectorType === VectorType.Flat && this.schema.kind === 'element') {
      if (!decodeElementValueImpl) {
        throw new Error('element value decoder not registered (internal error)');
      }
      const isNode = this.schema.type === ColumnType.Node;
      value = decodeElementValueImpl(
        this.ctx,
        this.vector,
        rowIndex,
        isNode,
        this.getPropVectorIndex(),
        this.schema,
      );
    } else if (this.vectorType === VectorType.Flat && this.schema.kind === 'path') {
      if (!decodePathValueImpl) {
        throw new Error('path value decoder not registered (internal error)');
      }
      value = decodePathValueImpl(
        this.ctx,
        this.vector,
        rowIndex,
        this.getPathMeta(),
        this.schema.nodeGraphElementProps,
        this.schema.edgeGraphElementProps,
      );
    } else if (this.schema.type === ColumnType.Any) {
      if (!decodeAnyValueImpl) {
        throw new Error('any value decoder not registered (internal error)');
      }
      value = decodeAnyValueImpl(this.ctx, this.vector, rowIndex);
    } else {
      if (!decodeValueImpl) {
        throw new Error('value decoder not registered (internal error)');
      }
      value = decodeValueImpl(this.ctx, this.vector, this.vectorType, rowIndex, this.schema);
    }

    if (this.vectorType === VectorType.Const) {
      this.constValue = value;
    }
    return value;
  }
}
