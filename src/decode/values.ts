/**
 * Per-type value decoders — the dispatch table invoked by VectorWrapper for
 * every (ColumnType, VectorType) combination.
 *
 * Dispatch structure mirrors nebula-go's `vectorDecoder.decodeValue()` /
 * `decodeFlatValue()` / `decodeConstValue()` (resultTable_helper.go):
 *  - Flat vectors: dispatch by ColumnType to a dedicated per-row decoder.
 *  - Const vectors: basic types read directly from vector_data via
 *    decodeBasicValue; composite types go through the self-describing
 *    decodeAnyCompositeValue format (same wire format as ColumnType.Any).
 *  - Node/Edge/Path have dedicated entry points (registerElementValueDecoder
 *    / registerPathValueDecoder) because they need metadata resolved during
 *    VectorWrapper.prepare() that a bare TypeSchema cannot express.
 *  - Any-typed columns have their own entry point (registerAnyValueDecoder)
 *    since each row carries its own type tag.
 */

import type { NestedVector } from '../generated/nebula/vector.js';
import { BASIC_TYPE_SIZE, ColumnType, isBasicColumnType } from '../types/columnType.js';
import { nullValue, type NebulaValueOrNull } from '../types/value.js';
import { decodeAnyCompositeValue, decodeAnyFlatValue } from './anyValue.js';
import { decodeBasicValue } from './basicValue.js';
import { BytesReader } from './bytesReader.js';
import {
  decodeEdgeFlatValue,
  decodeListFlatValue,
  decodeMapFlatValue,
  decodeNodeFlatValue,
  decodePathFlatValue,
  decodeRecordFlatValue,
  decodeSetFlatValue,
} from './compositeValue.js';
import type { DecodeContext } from './decodeContext.js';
import { decodeVectorFlatValue } from './embeddingVector.js';
import { decodeGeographyFlatValue } from './geography.js';
import { isRowNull } from './nullBitmap.js';
import type { PathMetaData } from './pathMeta.js';
import type { PropVectorIndex } from './propVectorIndex.js';
import { decodePropVectorIndex } from './propVectorIndex.js';
import { decodeDecimalFlatValue, decodeStringFlatValue } from './stringValue.js';
import type { GraphElementPropsByGraph, PropSchema, TypeSchema } from './typeSchema.js';
import {
  registerAnyValueDecoder,
  registerElementValueDecoder,
  registerPathValueDecoder,
  registerValueDecoder,
  VectorType,
} from './vectorWrapper.js';

/** Generic dispatcher for every column type except Node/Edge/Path/Any, which
 * have dedicated entry points registered separately below. */
function decodeValue(
  ctx: DecodeContext,
  vector: NestedVector,
  vectorType: VectorType,
  rowIndex: number,
  schema: TypeSchema,
): NebulaValueOrNull {
  if (schema.type === ColumnType.Unknown) {
    return nullValue(ColumnType.Unknown);
  }

  const nullCheckIndex = vectorType === VectorType.Const ? 0 : rowIndex;
  if (isRowNull(vector.nullBitMap, nullCheckIndex)) {
    return nullValue(schema.type);
  }

  if (vectorType === VectorType.Flat) {
    return decodeFlatValue(ctx, vector, rowIndex, schema);
  }
  if (vectorType === VectorType.Const) {
    const r = new BytesReader(vector.vectorData);
    return decodeConstValue(ctx, r, schema.type);
  }
  throw new Error(`decodeValue: unsupported vector type ${VectorType[vectorType]}`);
}

function decodeConstValue(ctx: DecodeContext, r: BytesReader, typ: ColumnType): NebulaValueOrNull {
  if (isBasicColumnType(typ)) {
    const size = BASIC_TYPE_SIZE.get(typ);
    if (size === undefined) {
      throw new Error(`decodeConstValue: no size registered for ${ColumnType[typ]}`);
    }
    const bs = r.readN(size);
    return decodeBasicValue(bs, typ, ctx.timezoneOffsetSec);
  }
  return decodeAnyCompositeValue(ctx, r, typ);
}

function decodeFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  schema: TypeSchema,
): NebulaValueOrNull {
  const typ = schema.type;

  if (isBasicColumnType(typ)) {
    const size = BASIC_TYPE_SIZE.get(typ)!;
    const start = rowIndex * size;
    if (v.vectorData.length < start + size) {
      throw new Error(`decodeFlatValue: out of range for column type ${ColumnType[typ]}`);
    }
    const bs = v.vectorData.subarray(start, start + size);
    return decodeBasicValue(bs, typ, ctx.timezoneOffsetSec);
  }

  switch (typ) {
    case ColumnType.String:
      return decodeStringFlatValue(v, rowIndex);
    case ColumnType.Decimal:
      return decodeDecimalFlatValue(v, rowIndex);
    case ColumnType.Geography: {
      const data = decodeGeographyFlatValue(v.vectorData, v.nestedVectors, rowIndex);
      return { type: ColumnType.Geography, isNull: false, data };
    }
    case ColumnType.Vector: {
      if (schema.kind !== 'vector') {
        throw new Error('decodeFlatValue: expected vector schema for ColumnType.Vector');
      }
      const data = decodeVectorFlatValue(v.vectorData, schema.dim, rowIndex);
      return { type: ColumnType.Vector, isNull: false, data };
    }
    case ColumnType.List: {
      if (schema.kind !== 'list') {
        throw new Error('decodeFlatValue: expected list schema');
      }
      const data = decodeListFlatValue(ctx, v, rowIndex, schema.sub, decodeValue);
      return { type: ColumnType.List, isNull: false, data };
    }
    case ColumnType.Set: {
      if (schema.kind !== 'set') {
        throw new Error('decodeFlatValue: expected set schema');
      }
      const data = decodeSetFlatValue(ctx, v, rowIndex, schema.sub, decodeValue);
      return { type: ColumnType.Set, isNull: false, data };
    }
    case ColumnType.Map: {
      if (schema.kind !== 'map') {
        throw new Error('decodeFlatValue: expected map schema');
      }
      const data = decodeMapFlatValue(ctx, v, rowIndex, schema.key, schema.value, decodeValue);
      return { type: ColumnType.Map, isNull: false, data };
    }
    case ColumnType.Record: {
      if (schema.kind !== 'record') {
        throw new Error('decodeFlatValue: expected record schema');
      }
      const data = decodeRecordFlatValue(ctx, v, rowIndex, schema.props, decodeValue);
      return { type: ColumnType.Record, isNull: false, data };
    }
    default:
      throw new Error(`decodeFlatValue: unsupported column type ${ColumnType[typ]}`);
  }
}

/** Node/Edge entry point: needs the resolved propVectorIndex from
 * VectorWrapper.prepare(), which a bare TypeSchema cannot carry. */
function decodeElementValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  isNode: boolean,
  propVectorIndex: PropVectorIndex,
  schema: Extract<TypeSchema, { kind: 'element' }>,
): NebulaValueOrNull {
  if (isRowNull(v.nullBitMap, rowIndex)) {
    return nullValue(schema.type);
  }
  const propSchemaLookup = (
    graphId: number,
    elementTypeId: number,
  ): ReadonlyMap<string, PropSchema> => {
    const props = schema.graphElementProps.get(graphId)?.get(elementTypeId);
    if (!props) {
      throw new Error(`element type not found: graphId=${graphId}, elementTypeId=${elementTypeId}`);
    }
    // Returned directly (no copy): `props` is immutable and invariant for a
    // given (graphId, elementTypeId) across every row in this column, so
    // there is nothing to gain from rebuilding a derived Map per row.
    return props;
  };

  if (isNode) {
    const data = decodeNodeFlatValue(ctx, v, rowIndex, propVectorIndex, decodeValue, propSchemaLookup);
    return { type: ColumnType.Node, isNull: false, data };
  }
  const data = decodeEdgeFlatValue(ctx, v, rowIndex, propVectorIndex, decodeValue, propSchemaLookup);
  return { type: ColumnType.Edge, isNull: false, data };
}

/** Path entry point: needs the resolved pair metadata from VectorWrapper.prepare().
 * Node/Edge elements within the path each need their own propVectorIndex resolved
 * from their `cur` NestedVector's special_meta_data (the same step VectorWrapper.
 * prepare() performs for a plain Node/Edge column), since path traversal jumps
 * between multiple distinct node/edge type "pair" vectors that were never
 * wrapped individually. */
function decodePathValueEntry(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  meta: PathMetaData,
  nodeGraphElementProps: GraphElementPropsByGraph,
  edgeGraphElementProps: GraphElementPropsByGraph,
): NebulaValueOrNull {
  if (isRowNull(v.nullBitMap, rowIndex)) {
    return nullValue(ColumnType.Path);
  }
  const nodeSchema: Extract<TypeSchema, { kind: 'element' }> = {
    kind: 'element',
    graphElementProps: nodeGraphElementProps,
    type: ColumnType.Node,
  };
  const edgeSchema: Extract<TypeSchema, { kind: 'element' }> = {
    kind: 'element',
    graphElementProps: edgeGraphElementProps,
    type: ColumnType.Edge,
  };

  // Cache resolved propVectorIndex per distinct `cur` NestedVector instance,
  // since decodePathFlatValue may revisit the same pair's `cur` vector across
  // multiple rows/elements.
  const propIndexCache = new Map<NestedVector, PropVectorIndex>();
  const recurseForElement = (isNode: boolean) => {
    return (
      elemCtx: DecodeContext,
      elemVector: NestedVector,
      _vectorType: VectorType,
      elemRowIndex: number,
      _schema: TypeSchema,
    ): NebulaValueOrNull => {
      let propVectorIndex = propIndexCache.get(elemVector);
      if (!propVectorIndex) {
        const schema = isNode ? nodeSchema : edgeSchema;
        propVectorIndex = decodePropVectorIndex(
          elemVector.specialMetaData,
          schema.graphElementProps,
          isNode,
        );
        propIndexCache.set(elemVector, propVectorIndex);
      }
      return decodeElementValue(
        elemCtx,
        elemVector,
        elemRowIndex,
        isNode,
        propVectorIndex,
        isNode ? nodeSchema : edgeSchema,
      );
    };
  };

  const data = decodePathFlatValue(
    ctx,
    v,
    rowIndex,
    meta,
    nodeSchema,
    edgeSchema,
    // decodePathFlatValue always passes the *element* schema (node or edge)
    // for `cur` vectors and the Int64 basic schema for `adj` vectors; dispatch
    // on schema.kind to pick the right recursion strategy.
    (elemCtx, elemVector, vectorType, elemRowIndex, schema) => {
      if (schema.kind === 'element') {
        return recurseForElement(schema.type === ColumnType.Node)(
          elemCtx,
          elemVector,
          vectorType,
          elemRowIndex,
          schema,
        );
      }
      return decodeValue(elemCtx, elemVector, vectorType, elemRowIndex, schema);
    },
  );
  return { type: ColumnType.Path, isNull: false, data };
}

/** Any-typed column entry point: each row carries its own type tag in
 * nested_vectors[0], so decoding does not go through the schema-driven path. */
function decodeAnyValueEntry(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
): NebulaValueOrNull {
  const typeVector = v.nestedVectors[0];
  if (!typeVector) {
    throw new Error('Any value: missing type nested_vectors[0]');
  }
  return decodeAnyFlatValue(ctx, v.vectorData, typeVector.vectorData, v.nestedVectors, rowIndex);
}

registerValueDecoder(decodeValue);
registerElementValueDecoder(decodeElementValue);
registerPathValueDecoder(decodePathValueEntry);
registerAnyValueDecoder(decodeAnyValueEntry);
