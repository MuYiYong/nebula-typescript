/**
 * typeSchema — recursive parser for the binary column-type descriptors found
 * in VectorTableMetaData.row_type.column_types[i].value_type.
 *
 * Each column type is a self-describing byte stream: 1 byte type code,
 * followed by type-specific sub-structure for composite types (List/Set get
 * one recursive sub-schema, Map gets two, Record/Node/Edge/Path/Vector/Decimal
 * each have their own layout). See findings-go.md section 5.3 and the
 * verified reference implementation in nebula-go/internal/decode/columnType.go.
 *
 * All integer fields in these descriptors are little-endian.
 */

import { BytesReader } from './bytesReader.js';
import { lookupColumnType } from './columnTypeMap.js';
import { ColumnType } from '../types/columnType.js';

/** A single property's name + type within a Node/Edge element type. */
export interface PropSchema {
  readonly name: string;
  readonly schema: TypeSchema;
}

/** propName -> PropSchema for one specific node/edge type id. */
export type ElementProps = ReadonlyMap<string, PropSchema>;

/** elementTypeId -> ElementProps, for one specific graph id. */
export type GraphElementProps = ReadonlyMap<number, ElementProps>;

/** graphId -> GraphElementProps. Aggregated across all Node or Edge type
 * variants seen for a Node/Edge/Path column. */
export type GraphElementPropsByGraph = Map<number, Map<number, Map<string, PropSchema>>>;

export type TypeSchema =
  | { readonly kind: 'basic'; readonly type: ColumnType }
  | { readonly kind: 'list'; readonly type: ColumnType.List; readonly sub: TypeSchema }
  | { readonly kind: 'set'; readonly type: ColumnType.Set; readonly sub: TypeSchema }
  | {
      readonly kind: 'map';
      readonly type: ColumnType.Map;
      readonly key: TypeSchema;
      readonly value: TypeSchema;
    }
  | {
      readonly kind: 'record';
      readonly type: ColumnType.Record;
      readonly props: ReadonlyMap<string, TypeSchema>;
    }
  | {
      readonly kind: 'element';
      readonly type: ColumnType.Node | ColumnType.Edge;
      readonly graphElementProps: GraphElementPropsByGraph;
    }
  | {
      readonly kind: 'path';
      readonly type: ColumnType.Path;
      readonly nodeGraphElementProps: GraphElementPropsByGraph;
      readonly edgeGraphElementProps: GraphElementPropsByGraph;
    }
  | { readonly kind: 'vector'; readonly type: ColumnType.Vector; readonly dim: number; readonly sub: TypeSchema };

export function getSchemaType(schema: TypeSchema): ColumnType {
  return schema.type;
}

/** Parses one type descriptor from the reader, recursing into sub-schemas. */
export function parseTypeSchema(r: BytesReader): TypeSchema {
  const code = r.readUint8();
  const t = lookupColumnType(code);

  switch (t) {
    case ColumnType.List: {
      const sub = parseTypeSchema(r);
      return { kind: 'list', type: ColumnType.List, sub };
    }
    case ColumnType.Set: {
      const sub = parseTypeSchema(r);
      return { kind: 'set', type: ColumnType.Set, sub };
    }
    case ColumnType.Map: {
      const key = parseTypeSchema(r);
      const value = parseTypeSchema(r);
      return { kind: 'map', type: ColumnType.Map, key, value };
    }
    case ColumnType.Record: {
      const numFields = r.readInt32LE();
      const props = new Map<string, TypeSchema>();
      for (let i = 0; i < numFields; i++) {
        const nameLen = r.readInt16LE();
        const name = r.readN(nameLen).toString('utf-8');
        const propSchema = parseTypeSchema(r);
        props.set(name, propSchema);
      }
      return { kind: 'record', type: ColumnType.Record, props };
    }
    case ColumnType.Node: {
      const graphElementProps = decodeElementTypes(r, true);
      return { kind: 'element', type: ColumnType.Node, graphElementProps };
    }
    case ColumnType.Edge: {
      const graphElementProps = decodeElementTypes(r, false);
      return { kind: 'element', type: ColumnType.Edge, graphElementProps };
    }
    case ColumnType.Path: {
      const nodeGraphElementProps: GraphElementPropsByGraph = new Map();
      const edgeGraphElementProps: GraphElementPropsByGraph = new Map();
      const elementNum = r.readInt32LE();
      for (let i = 0; i < elementNum; i++) {
        const elementSchema = parseTypeSchema(r);
        if (elementSchema.kind === 'element' && elementSchema.type === ColumnType.Node) {
          mergeGraphElementProps(nodeGraphElementProps, elementSchema.graphElementProps);
        } else if (elementSchema.kind === 'element' && elementSchema.type === ColumnType.Edge) {
          mergeGraphElementProps(edgeGraphElementProps, elementSchema.graphElementProps);
        } else {
          throw new Error('invalid column type: expected Node or Edge element schema inside Path');
        }
      }
      return { kind: 'path', type: ColumnType.Path, nodeGraphElementProps, edgeGraphElementProps };
    }
    case ColumnType.Decimal: {
      // precision (2B) + scale (2B), currently unused by the decoder.
      r.readN(2);
      r.readN(2);
      return { kind: 'basic', type: ColumnType.Decimal };
    }
    case ColumnType.Vector: {
      const dim = r.readUint32LE();
      const sub = parseTypeSchema(r);
      if (sub.type !== ColumnType.Float32) {
        throw new Error('invalid column type: embedding vector sub-schema must be Float32');
      }
      return { kind: 'vector', type: ColumnType.Vector, dim, sub };
    }
    case ColumnType.Geography:
      return { kind: 'basic', type: ColumnType.Geography };
    default:
      return { kind: 'basic', type: t };
  }
}

function mergeGraphElementProps(
  target: GraphElementPropsByGraph,
  source: GraphElementPropsByGraph,
): void {
  for (const [graphId, elementProps] of source) {
    let targetElementProps = target.get(graphId);
    if (!targetElementProps) {
      targetElementProps = new Map();
      target.set(graphId, targetElementProps);
    }
    for (const [elementTypeId, props] of elementProps) {
      targetElementProps.set(elementTypeId, props);
    }
  }
}

/**
 * Decodes the element-type table embedded in a Node or Edge column's type
 * schema: numElementType + [graphId(4B) + elementTypeId(Node:2B/Edge:4B) +
 * numProps(4B) + [nameLen(2B) + name + propTypeSchema]].
 */
function decodeElementTypes(r: BytesReader, isNode: boolean): GraphElementPropsByGraph {
  const numElementType = r.readInt32LE();
  const result: GraphElementPropsByGraph = new Map();

  for (let i = 0; i < numElementType; i++) {
    const graphId = r.readInt32LE();
    const elementTypeId = isNode ? r.readInt16LE() : r.readInt32LE();

    let elementProps = result.get(graphId);
    if (!elementProps) {
      elementProps = new Map();
      result.set(graphId, elementProps);
    }

    const props = new Map<string, PropSchema>();
    const numProps = r.readInt32LE();
    for (let j = 0; j < numProps; j++) {
      const nameLen = r.readInt16LE();
      const name = r.readN(nameLen).toString('utf-8');
      const schema = parseTypeSchema(r);
      props.set(name, { name, schema });
    }
    elementProps.set(elementTypeId, props);
  }

  return result;
}
