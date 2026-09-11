/**
 * decodeAnyCompositeValue — self-describing, recursive TLV decoder used both
 * for ColumnType.Any columns and for Const-vector composite values (both
 * paths reuse this same format on the wire). See findings-go.md section
 * 5.17.
 *
 * Unlike the columnar decoders, this format carries its own type tag and
 * length prefixes inline, so it does not need a pre-parsed TypeSchema beyond
 * knowing the *first* value's type (the caller supplies it; nested calls
 * read their own type byte from the stream).
 */

import { BytesReader, bytesToUint32LE } from './bytesReader.js';
import { ColumnType, EdgeDirection, isBasicColumnType } from '../types/columnType.js';
import { lookupColumnType } from './columnTypeMap.js';
import { decodeBasicValue } from './basicValue.js';
import { decodeGeographyData } from './geography.js';
import type { DecodeContext } from './decodeContext.js';
import { getSchemaName } from './graphSchema.js';
import {
  nullValue,
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

function readNullBitmapFlags(r: BytesReader, size: number): boolean[] {
  const bitSize = size % 8 !== 0 ? Math.floor(size / 8) + 1 : size / 8;
  const bytes = r.readN(bitSize);
  const flags: boolean[] = [];
  for (let i = 0; i < size; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = i % 8;
    flags.push((bytes[byteIdx]! & (1 << bitIdx)) !== 0);
  }
  return flags;
}

export function decodeAnyCompositeValue(
  ctx: DecodeContext,
  r: BytesReader,
  typ: ColumnType,
): NebulaValueOrNull {
  if (isBasicColumnType(typ)) {
    const size = basicSize(typ);
    const bs = r.readN(size);
    return decodeBasicValue(bs, typ, ctx.timezoneOffsetSec);
  }

  switch (typ) {
    case ColumnType.Unknown:
      return nullValue(ColumnType.Unknown);

    case ColumnType.String:
    case ColumnType.Decimal: {
      const size = r.readUint16LE();
      const bs = r.readN(size);
      if (typ === ColumnType.Decimal) {
        return { type: ColumnType.Decimal, isNull: false, data: { sval: bs.toString('utf-8') } };
      }
      return { type: ColumnType.String, isNull: false, data: bs.toString('utf-8') };
    }

    case ColumnType.List: {
      const subType = lookupColumnType(r.readUint8());
      const size = r.readUint16LE();
      const present = readNullBitmapFlags(r, size);
      const values: NebulaValueOrNull[] = [];
      for (let i = 0; i < size; i++) {
        values.push(present[i] ? decodeAnyCompositeValue(ctx, r, subType) : nullValue(subType));
      }
      const data: NebulaList = { values: values as readonly NebulaValue[] };
      return { type: ColumnType.List, isNull: false, data };
    }

    case ColumnType.Set: {
      const subType = lookupColumnType(r.readUint8());
      const size = r.readUint32LE();
      const present = readNullBitmapFlags(r, size);
      const values: NebulaValueOrNull[] = [];
      for (let i = 0; i < size; i++) {
        values.push(present[i] ? decodeAnyCompositeValue(ctx, r, subType) : nullValue(subType));
      }
      const data: NebulaSet = { values: values as readonly NebulaValue[] };
      return { type: ColumnType.Set, isNull: false, data };
    }

    case ColumnType.Map: {
      const keysValue = decodeAnyCompositeValue(ctx, r, ColumnType.Set);
      const valuesValue = decodeAnyCompositeValue(ctx, r, ColumnType.Set);
      if (
        keysValue.isNull ||
        valuesValue.isNull ||
        keysValue.type !== ColumnType.Set ||
        valuesValue.type !== ColumnType.Set
      ) {
        throw new Error('decodeAnyCompositeValue: malformed Map encoding');
      }
      const keys = keysValue.data.values;
      const values = valuesValue.data.values;
      if (keys.length !== values.length) {
        throw new Error('decodeAnyCompositeValue: map key size not equal to value size');
      }
      const entries = new Map<NebulaValue, NebulaValue>();
      for (let i = 0; i < keys.length; i++) {
        entries.set(keys[i]!, values[i]!);
      }
      const data: NebulaMap = { entries };
      return { type: ColumnType.Map, isNull: false, data };
    }

    case ColumnType.Record: {
      const size = r.readUint16LE();
      const values = new Map<string, NebulaValue>();
      for (let i = 0; i < size; i++) {
        const nameLen = r.readInt16LE();
        const name = r.readN(nameLen).toString('utf-8');
        const subType = lookupColumnType(r.readUint8());
        const v = decodeAnyCompositeValue(ctx, r, subType);
        if (!v.isNull) values.set(name, v as NebulaValue);
      }
      const data: NebulaRecord = { values };
      return { type: ColumnType.Record, isNull: false, data };
    }

    case ColumnType.Node: {
      const nodeId = r.readInt64LE();
      const nodeTypeId = Number(nodeId >> 48n);
      const graphId = r.readInt32LE();
      const propSize = r.readUint16LE();
      const properties = new Map<string, NebulaValue>();
      for (let i = 0; i < propSize; i++) {
        const nameLen = r.readInt16LE();
        const name = r.readN(nameLen).toString('utf-8');
        const subType = lookupColumnType(r.readUint8());
        const v = decodeAnyCompositeValue(ctx, r, subType);
        if (!v.isNull) properties.set(name, v as NebulaValue);
      }
      const { graphName, typeName, labels } = getSchemaName(
        ctx.graphsSchema,
        graphId,
        nodeTypeId,
        true,
      );
      const data: NebulaNode = { nodeId, graph: graphName, type: typeName, labels, properties };
      return { type: ColumnType.Node, isNull: false, data };
    }

    case ColumnType.Edge: {
      const srcNodeId = r.readInt64LE();
      const dstNodeId = r.readInt64LE();
      const edgeRank = r.readInt64LE();
      const graphId = r.readInt32LE();
      const edgeTypeIdRaw = r.readInt32LE();
      const propSize = r.readUint16LE();
      const noDirectType = edgeTypeIdRaw & 0x3fffffff;
      const direction = ((edgeTypeIdRaw >>> 30) & 0x3) as EdgeDirection;
      const properties = new Map<string, NebulaValue>();
      for (let i = 0; i < propSize; i++) {
        const nameLen = r.readInt16LE();
        const name = r.readN(nameLen).toString('utf-8');
        const subType = lookupColumnType(r.readUint8());
        const v = decodeAnyCompositeValue(ctx, r, subType);
        if (!v.isNull) properties.set(name, v as NebulaValue);
      }
      const { graphName, typeName, labels } = getSchemaName(
        ctx.graphsSchema,
        graphId,
        noDirectType,
        false,
      );
      const [srcId, dstId] =
        direction === EdgeDirection.Incoming ? [dstNodeId, srcNodeId] : [srcNodeId, dstNodeId];
      const data: NebulaEdge = {
        srcId,
        dstId,
        rank: edgeRank,
        direction,
        graph: graphName,
        type: typeName,
        labels,
        properties,
      };
      return { type: ColumnType.Edge, isNull: false, data };
    }

    case ColumnType.Path: {
      const elementNum = r.readInt16LE();
      const values: NebulaValue[] = [];
      for (let i = 0; i < elementNum; i++) {
        const subType = lookupColumnType(r.readUint8());
        const v = decodeAnyCompositeValue(ctx, r, subType);
        if (!v.isNull) values.push(v as NebulaValue);
      }
      const data: NebulaPath = { values };
      return { type: ColumnType.Path, isNull: false, data };
    }

    case ColumnType.Vector: {
      const size = r.readInt16LE();
      const values: number[] = [];
      for (let i = 0; i < size; i++) {
        values.push(r.readFloat32LE());
      }
      return { type: ColumnType.Vector, isNull: false, data: { values } };
    }

    case ColumnType.Geography: {
      const data = decodeGeographyData(r);
      return { type: ColumnType.Geography, isNull: false, data };
    }

    default:
      throw new Error(`decodeAnyCompositeValue: unsupported column type ${ColumnType[typ]}`);
  }
}

function basicSize(typ: ColumnType): number {
  switch (typ) {
    case ColumnType.Bool:
    case ColumnType.Int8:
    case ColumnType.Uint8:
      return 1;
    case ColumnType.Int16:
    case ColumnType.Uint16:
      return 2;
    case ColumnType.Int32:
    case ColumnType.Uint32:
    case ColumnType.Float32:
    case ColumnType.Date:
      return 4;
    case ColumnType.Int64:
    case ColumnType.Uint64:
    case ColumnType.Float64:
    case ColumnType.LocalTime:
    case ColumnType.ZonedTime:
    case ColumnType.LocalDatetime:
    case ColumnType.ZonedDatetime:
    case ColumnType.Duration:
      return 8;
    default:
      throw new Error(`basicSize: unsupported column type ${ColumnType[typ]}`);
  }
}

/** Decodes a whole Any-typed column value at a given row for a Flat vector:
 * reads the row's type tag from nested_vectors[0], then either an inline
 * 8-byte basic value or a {chunkIndex, chunkOffset} pointer into
 * nested_vectors[chunkIndex+1]. See findings-go.md section 5.17. */
export function decodeAnyFlatValue(
  ctx: DecodeContext,
  vectorData: Buffer,
  typeVectorData: Buffer,
  nestedVectors: readonly { vectorData: Buffer }[],
  rowIndex: number,
): NebulaValueOrNull {
  const dataType = lookupColumnType(typeVectorData[rowIndex]!);
  const headerLength = 8;
  const dataBytes = vectorData.subarray(
    rowIndex * headerLength,
    rowIndex * headerLength + headerLength,
  );

  if (isBasicColumnType(dataType)) {
    return decodeBasicValue(
      dataBytes.subarray(0, basicSize(dataType)),
      dataType,
      ctx.timezoneOffsetSec,
    );
  }

  const chunkIndex = bytesToUint32LE(dataBytes, 0);
  const chunkOffset = bytesToUint32LE(dataBytes, 4);
  const chunk = nestedVectors[chunkIndex + 1];
  if (!chunk) {
    throw new Error(`Any value: missing nested vector chunk at index ${chunkIndex + 1}`);
  }
  const r = new BytesReader(chunk.vectorData, chunkOffset);
  return decodeAnyCompositeValue(ctx, r, dataType);
}
