/**
 * Property-vector-index resolution for Node/Edge columns.
 *
 * A Node/Edge column's `special_meta_data` encodes, per element type, which
 * `nested_vectors[i]` slot holds each property's data:
 *
 *   propsNum(4B) + propsNum x { nameLen(2B) + name } +
 *   elementTypeNum(4B) + elementTypeNum x {
 *       graphId(4B) + elementTypeId(Node:2B/Edge:4B) + propNum(4B) +
 *       propNum x { vectorIndex(4B) }
 *   }
 *
 * See findings-go.md section 5.14 (`decodePropVectorIndex`).
 */

import { BytesReader } from './bytesReader.js';
import type { GraphElementPropsByGraph } from './typeSchema.js';

export class PropNotFoundError extends Error {
  constructor(name: string) {
    super(`property not found in schema: ${name}`);
    this.name = 'PropNotFoundError';
  }
}

/** Resolved vectorIndex per (graphId, elementTypeId, propName). */
export type PropVectorIndex = Map<number, Map<number, Map<string, number>>>;

export function decodePropVectorIndex(
  specialMetaData: Buffer,
  graphElementProps: GraphElementPropsByGraph,
  isNode: boolean,
): PropVectorIndex {
  const r = new BytesReader(specialMetaData);
  const result: PropVectorIndex = new Map();

  const propsNum = r.readInt32LE();
  const propList: string[] = [];
  for (let i = 0; i < propsNum; i++) {
    const nameLen = r.readInt16LE();
    propList.push(r.readN(nameLen).toString('utf-8'));
  }

  const elementTypeNum = r.readInt32LE();
  for (let i = 0; i < elementTypeNum; i++) {
    const graphId = r.readInt32LE();
    const elementTypeId = isNode ? r.readInt16LE() : r.readInt32LE();
    const propNum = r.readInt32LE();

    const elementProps = graphElementProps.get(graphId);
    if (!elementProps) {
      throw new PropNotFoundError(`graphId=${graphId}`);
    }
    const props = elementProps.get(elementTypeId);
    if (!props) {
      throw new PropNotFoundError(`elementTypeId=${elementTypeId}`);
    }

    let graphResult = result.get(graphId);
    if (!graphResult) {
      graphResult = new Map();
      result.set(graphId, graphResult);
    }
    let elementResult = graphResult.get(elementTypeId);
    if (!elementResult) {
      elementResult = new Map();
      graphResult.set(elementTypeId, elementResult);
    }

    for (let j = 0; j < propNum; j++) {
      const vectorIndex = r.readInt32LE();
      const propName = propList[vectorIndex];
      if (propName === undefined || !props.has(propName)) {
        throw new PropNotFoundError(propName ?? `<index ${vectorIndex}>`);
      }
      elementResult.set(propName, vectorIndex);
    }
  }

  return result;
}
