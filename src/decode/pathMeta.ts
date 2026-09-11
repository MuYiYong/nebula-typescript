/**
 * Path special-metadata decoding: builds the (nodeTypeId|edgeTypeId) ->
 * pairIndex -> {cur, adj} NestedVector mapping used to traverse a Path's
 * alternating Node/Edge elements.
 *
 * Layout of NestedVector.special_meta_data for a Path column:
 *   nodeTypeNum(4B) + nodeTypeNum x { graphId(4B) + nodeTypeId(2B) + pairIndex(2B) } +
 *   edgeTypeNum(4B) + edgeTypeNum x { graphId(4B) + edgeTypeId(4B) + pairIndex(2B) }
 *
 * Each type consumes 2 consecutive entries in `nested_vectors`: [cur, adj].
 * See findings-go.md section 5.16.
 */

import { BytesReader } from './bytesReader.js';
import type { NestedVector } from '../generated/nebula/vector.js';

export interface PathPair {
  readonly cur: NestedVector;
  readonly adj: NestedVector;
}

export interface PathMetaData {
  readonly nodeTypeIndex: ReadonlyMap<number, number>; // nodeTypeId -> pairIndex
  readonly edgeTypeIndex: ReadonlyMap<number, number>; // edgeTypeId -> pairIndex
  readonly nodeIndexPair: ReadonlyMap<number, PathPair>; // pairIndex -> pair
  readonly edgeIndexPair: ReadonlyMap<number, PathPair>; // pairIndex -> pair
}

export function decodePathSpecialData(v: NestedVector): PathMetaData {
  const r = new BytesReader(v.specialMetaData);
  const nodeTypeIndex = new Map<number, number>();
  const edgeTypeIndex = new Map<number, number>();
  const nodeIndexPair = new Map<number, PathPair>();
  const edgeIndexPair = new Map<number, PathPair>();

  let nestedVectorIndex = 0;

  const nodeTypeNum = r.readInt32LE();
  for (let i = 0; i < nodeTypeNum; i++) {
    r.readN(4); // graphId (unused for lookup, matches reference implementation)
    const nodeTypeId = r.readUint16LE();
    const pairIndex = r.readUint16LE();
    nodeTypeIndex.set(nodeTypeId, pairIndex);
    const cur = v.nestedVectors[nestedVectorIndex];
    const adj = v.nestedVectors[nestedVectorIndex + 1];
    if (!cur || !adj) {
      throw new Error(`path metadata: missing nested vectors at index ${nestedVectorIndex}`);
    }
    nodeIndexPair.set(pairIndex, { cur, adj });
    nestedVectorIndex += 2;
  }

  const edgeTypeNum = r.readInt32LE();
  for (let i = 0; i < edgeTypeNum; i++) {
    r.readN(4); // graphId
    const edgeTypeId = r.readInt32LE();
    const pairIndex = r.readInt16LE();
    edgeTypeIndex.set(edgeTypeId, pairIndex);
    const cur = v.nestedVectors[nestedVectorIndex];
    const adj = v.nestedVectors[nestedVectorIndex + 1];
    if (!cur || !adj) {
      throw new Error(`path metadata: missing nested vectors at index ${nestedVectorIndex}`);
    }
    edgeIndexPair.set(pairIndex, { cur, adj });
    nestedVectorIndex += 2;
  }

  return { nodeTypeIndex, edgeTypeIndex, nodeIndexPair, edgeIndexPair };
}

/**
 * Decodes the packed 64-bit adjacency header used to traverse from one Path
 * element to the next:
 *   bit63    = isEnd
 *   bit62    = nextIsEdge
 *   bits[32..47] = nextVectorIndex (pairIndex of the next element)
 *   bits[0..31]  = nextOffset (row offset within the next element's vector)
 */
export interface PathAdjHeader {
  readonly isEnd: boolean;
  readonly nextIsEdge: boolean;
  readonly nextVectorIndex: number;
  readonly nextOffset: number;
}

export function decodePathAdjHeader(value: bigint): PathAdjHeader {
  const isEnd = ((value >> 63n) & 1n) === 1n;
  const nextIsEdge = ((value >> 62n) & 1n) === 1n;
  const nextVectorIndex = Number((value >> 32n) & 0xffffn);
  const nextOffset = Number(value & 0xffffffffn);
  return { isEnd, nextIsEdge, nextVectorIndex, nextOffset };
}
