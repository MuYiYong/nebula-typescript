/**
 * Composite flat-vector decoders: List/Set/Map/Record/Node/Edge/Path.
 *
 * Each of these delegates decoding of individual elements/properties back
 * into the generic `decodeValue` dispatcher (via a small callback passed in
 * by values.ts, avoiding a hard circular import between this module and the
 * top-level dispatcher).
 */

import { bytesToUint32LE } from './bytesReader.js';
import { ColumnType, EdgeDirection } from '../types/columnType.js';
import type { NestedVector } from '../generated/nebula/vector.js';
import type { DecodeContext } from './decodeContext.js';
import { getSchemaName } from './graphSchema.js';
import type { PathMetaData } from './pathMeta.js';
import { decodePathAdjHeader } from './pathMeta.js';
import type { PropVectorIndex } from './propVectorIndex.js';
import type { PropSchema, TypeSchema } from './typeSchema.js';
import { VectorType } from './vectorContentType.js';
import {
  asInt64,
  type NebulaEdge,
  type NebulaList,
  type NebulaMap,
  type NebulaNode,
  type NebulaPath,
  type NebulaRecord,
  type NebulaSet,
  type NebulaValue,
  type NebulaValueOrNull,
} from '../types/value.js';

/** Callback signature used to recursively decode a nested column's value at
 * a given row, supplied by values.ts to avoid a circular import. */
export type RecurseDecodeFn = (
  ctx: DecodeContext,
  vector: NestedVector,
  vectorType: VectorType,
  rowIndex: number,
  schema: TypeSchema,
) => NebulaValueOrNull;

const HEADER_LEN_OFFSET_SIZE = 8; // offset(4B) + size(4B), shared by List/Set/Map

function readOffsetSizeHeader(
  vectorData: Buffer,
  rowIndex: number,
): { offset: number; size: number } {
  const header = vectorData.subarray(
    rowIndex * HEADER_LEN_OFFSET_SIZE,
    rowIndex * HEADER_LEN_OFFSET_SIZE + HEADER_LEN_OFFSET_SIZE,
  );
  return { offset: bytesToUint32LE(header, 0), size: bytesToUint32LE(header, 4) };
}

export function decodeListFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  subSchema: TypeSchema,
  recurse: RecurseDecodeFn,
): NebulaList {
  const { offset, size } = readOffsetSizeHeader(v.vectorData, rowIndex);
  const elementVector = v.nestedVectors[0];
  if (!elementVector) {
    throw new Error('List value: missing nested_vectors[0]');
  }
  const values: NebulaValue[] = [];
  for (let i = 0; i < size; i++) {
    const val = recurse(ctx, elementVector, VectorType.Flat, offset + i, subSchema);
    values.push((val.isNull ? { type: subSchema.type, isNull: true, data: null } : val) as NebulaValue);
  }
  return { values };
}

export function decodeSetFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  subSchema: TypeSchema,
  recurse: RecurseDecodeFn,
): NebulaSet {
  const { offset, size } = readOffsetSizeHeader(v.vectorData, rowIndex);
  const elementVector = v.nestedVectors[0];
  if (!elementVector) {
    throw new Error('Set value: missing nested_vectors[0]');
  }
  const values: NebulaValue[] = [];
  for (let i = 0; i < size; i++) {
    const val = recurse(ctx, elementVector, VectorType.Flat, offset + i, subSchema);
    if (!val.isNull) values.push(val as NebulaValue);
  }
  return { values };
}

export function decodeMapFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  keySchema: TypeSchema,
  valueSchema: TypeSchema,
  recurse: RecurseDecodeFn,
): NebulaMap {
  const { offset, size } = readOffsetSizeHeader(v.vectorData, rowIndex);
  const keyVector = v.nestedVectors[0];
  const valueVector = v.nestedVectors[1];
  if (!keyVector || !valueVector) {
    throw new Error('Map value: missing nested_vectors[0] or [1]');
  }
  const entries = new Map<NebulaValue, NebulaValue>();
  for (let i = 0; i < size; i++) {
    const key = recurse(ctx, keyVector, VectorType.Flat, offset + i, keySchema);
    const val = recurse(ctx, valueVector, VectorType.Flat, offset + i, valueSchema);
    if (!key.isNull && !val.isNull) {
      entries.set(key as NebulaValue, val as NebulaValue);
    }
  }
  return { entries };
}

export function decodeRecordFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  propSchemas: ReadonlyMap<string, TypeSchema>,
  recurse: RecurseDecodeFn,
): NebulaRecord {
  // special_meta_data holds the field-name ordering matching nested_vectors[i].
  const fieldNames = readRecordFieldOrder(v.specialMetaData, propSchemas.size);
  const values = new Map<string, NebulaValue>();
  for (let i = 0; i < fieldNames.length; i++) {
    const name = fieldNames[i]!;
    const schema = propSchemas.get(name);
    if (!schema) {
      throw new Error(`Record value: prop not found in schema: ${name}`);
    }
    const nested = v.nestedVectors[i];
    if (!nested) {
      throw new Error(`Record value: missing nested_vectors[${i}]`);
    }
    const val = recurse(ctx, nested, VectorType.Flat, rowIndex, schema);
    if (!val.isNull) values.set(name, val as NebulaValue);
  }
  return { values };
}

function readRecordFieldOrder(specialMetaData: Buffer, numFields: number): string[] {
  const names: string[] = [];
  let pos = 0;
  for (let i = 0; i < numFields; i++) {
    const size = specialMetaData.readInt16LE(pos);
    pos += 2;
    names.push(specialMetaData.subarray(pos, pos + size).toString('utf-8'));
    pos += size;
  }
  return names;
}

export function decodeNodeFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  propVectorIndex: PropVectorIndex,
  recurse: RecurseDecodeFn,
  propSchemaLookup: (graphId: number, nodeTypeId: number) => ReadonlyMap<string, PropSchema>,
): NebulaNode {
  const headerLen = 16; // nodeId(8) + graphId(4) + padding(4)
  const header = v.vectorData.subarray(rowIndex * headerLen, rowIndex * headerLen + headerLen);
  const nodeId = header.readBigInt64LE(0);
  const graphId = header.readInt32LE(8);
  const nodeTypeId = Number(nodeId >> 48n);

  const graphProps = propVectorIndex.get(graphId);
  const elementProps = graphProps?.get(nodeTypeId);
  if (!elementProps) {
    throw new Error(
      `Node value: element type not found (graphId=${graphId}, nodeTypeId=${nodeTypeId})`,
    );
  }
  const { graphName, typeName, labels } = getSchemaName(ctx.graphsSchema, graphId, nodeTypeId, true);
  const propSchemas = propSchemaLookup(graphId, nodeTypeId);

  const properties = new Map<string, NebulaValue>();
  for (const [propName, vectorIndex] of elementProps) {
    const nested = v.nestedVectors[vectorIndex];
    const schema = propSchemas.get(propName)?.schema;
    if (!nested || !schema) {
      throw new Error(`Node value: missing nested vector or schema for prop ${propName}`);
    }
    const val = recurse(ctx, nested, VectorType.Flat, rowIndex, schema);
    if (!val.isNull) properties.set(propName, val as NebulaValue);
  }

  return { nodeId, graph: graphName, type: typeName, labels, properties };
}

export function decodeEdgeFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  propVectorIndex: PropVectorIndex,
  recurse: RecurseDecodeFn,
  propSchemaLookup: (graphId: number, edgeTypeId: number) => ReadonlyMap<string, PropSchema>,
): NebulaEdge {
  const headerLen = 32; // srcId(8)+dstId(8)+rank(8)+graphId(4)+edgeTypeId(4)
  const header = v.vectorData.subarray(rowIndex * headerLen, rowIndex * headerLen + headerLen);
  const srcId = header.readBigInt64LE(0);
  const dstId = header.readBigInt64LE(8);
  const rank = header.readBigInt64LE(16);
  const graphId = header.readInt32LE(24);
  const edgeTypeIdRaw = header.readInt32LE(28);
  const noDirectType = edgeTypeIdRaw & 0x3fffffff;
  const direction = ((edgeTypeIdRaw >>> 30) & 0x3) as EdgeDirection;

  const graphProps = propVectorIndex.get(graphId);
  const elementProps = graphProps?.get(noDirectType);
  if (!elementProps) {
    throw new Error(
      `Edge value: element type not found (graphId=${graphId}, edgeTypeId=${noDirectType})`,
    );
  }
  const { graphName, typeName, labels } = getSchemaName(
    ctx.graphsSchema,
    graphId,
    noDirectType,
    false,
  );
  const propSchemas = propSchemaLookup(graphId, noDirectType);

  const properties = new Map<string, NebulaValue>();
  for (const [propName, vectorIndex] of elementProps) {
    const nested = v.nestedVectors[vectorIndex];
    const schema = propSchemas.get(propName)?.schema;
    if (!nested || !schema) {
      throw new Error(`Edge value: missing nested vector or schema for prop ${propName}`);
    }
    const val = recurse(ctx, nested, VectorType.Flat, rowIndex, schema);
    if (!val.isNull) properties.set(propName, val as NebulaValue);
  }

  const [finalSrc, finalDst] = direction === EdgeDirection.Incoming ? [dstId, srcId] : [srcId, dstId];

  return {
    srcId: finalSrc!,
    dstId: finalDst!,
    rank,
    direction,
    graph: graphName,
    type: typeName,
    labels,
    properties,
  };
}

export function decodePathFlatValue(
  ctx: DecodeContext,
  v: NestedVector,
  rowIndex: number,
  meta: PathMetaData,
  nodeSchema: Extract<TypeSchema, { kind: 'element' }>,
  edgeSchema: Extract<TypeSchema, { kind: 'element' }>,
  recurse: RecurseDecodeFn,
): NebulaPath {
  const headerLen = 16; // totalNum(4) + headerIdx(2) + tailIdx(2) + headOffset(4) + tailOffset(4)
  const header = v.vectorData.subarray(rowIndex * headerLen, rowIndex * headerLen + headerLen);
  const totalNum = header.readInt32LE(0);
  const headerIdx = header.readUInt16LE(4);
  const headOffset = header.readUInt32LE(8);

  const values: NebulaValue[] = [];
  if (totalNum === 0) {
    return { values };
  }

  let sentinelPair = meta.nodeIndexPair.get(headerIdx);
  if (!sentinelPair) {
    throw new Error(`Path value: node pair not found for pairIndex=${headerIdx}`);
  }
  let sentinelIsEdge = false;
  let sentinelOffset = headOffset;
  const int64Schema: TypeSchema = { kind: 'basic', type: ColumnType.Int64 };

  for (let i = 0; i < totalNum; i++) {
    const schema = sentinelIsEdge ? edgeSchema : nodeSchema;
    const value = recurse(ctx, sentinelPair.cur, VectorType.Flat, sentinelOffset, schema);
    if (!value.isNull) values.push(value as NebulaValue);

    const headerValue = recurse(ctx, sentinelPair.adj, VectorType.Flat, sentinelOffset, int64Schema);
    const adjRaw = asInt64(headerValue);
    const adjHeader = decodePathAdjHeader(adjRaw);
    sentinelOffset = adjHeader.nextOffset;
    sentinelIsEdge = adjHeader.nextIsEdge;

    if (i < totalNum - 1) {
      sentinelPair = sentinelIsEdge
        ? meta.edgeIndexPair.get(adjHeader.nextVectorIndex)
        : meta.nodeIndexPair.get(adjHeader.nextVectorIndex);
      if (!sentinelPair) {
        throw new Error(`Path value: pair not found for pairIndex=${adjHeader.nextVectorIndex}`);
      }
    }
  }

  return { values };
}
