/**
 * Graph schema — per-graph node/edge type metadata used to resolve human
 * -readable names and labels for decoded Node/Edge values.
 * Mirrors nebula-go's `constructGraphsSchema()` (resultTable.go).
 */

import type { PropertyGraphSchema } from '../generated/nebula/vector.js';

export interface ElementSchema {
  readonly typeName: string;
  readonly typeId: number;
  readonly labels: readonly string[];
}

export interface GraphSchema {
  readonly name: string;
  readonly id: number;
  readonly nodesSchema: ReadonlyMap<number, ElementSchema>;
  readonly edgesSchema: ReadonlyMap<number, ElementSchema>;
}

export type GraphsSchema = ReadonlyMap<number, GraphSchema>;

export function constructGraphsSchema(graphSchemaList: readonly PropertyGraphSchema[]): GraphsSchema {
  const gsm = new Map<number, GraphSchema>();
  for (const g of graphSchemaList) {
    const nodesSchema = new Map<number, ElementSchema>();
    for (const n of g.nodeType) {
      nodesSchema.set(n.nodeTypeId, {
        typeName: n.nodeTypeName.toString('utf-8'),
        typeId: n.nodeTypeId,
        labels: n.label.map((l) => l.toString('utf-8')),
      });
    }
    const edgesSchema = new Map<number, ElementSchema>();
    for (const e of g.edgeType) {
      edgesSchema.set(e.edgeTypeId, {
        typeName: e.edgeTypeName.toString('utf-8'),
        typeId: e.edgeTypeId,
        labels: e.label.map((l) => l.toString('utf-8')),
      });
    }
    gsm.set(g.graphId, {
      name: g.graphName.toString('utf-8'),
      id: g.graphId,
      nodesSchema,
      edgesSchema,
    });
  }
  return gsm;
}

export class GraphSchemaNotFoundError extends Error {
  constructor(graphId: number) {
    super(`graph schema not found for graphId=${graphId}`);
    this.name = 'GraphSchemaNotFoundError';
  }
}

export class ElementTypeNotFoundError extends Error {
  constructor(elementTypeId: number) {
    super(`element type not found: elementTypeId=${elementTypeId}`);
    this.name = 'ElementTypeNotFoundError';
  }
}

export function getSchemaName(
  gsm: GraphsSchema,
  graphId: number,
  elementTypeId: number,
  isNode: boolean,
): { graphName: string; typeName: string; labels: readonly string[] } {
  const gs = gsm.get(graphId);
  if (!gs) {
    throw new GraphSchemaNotFoundError(graphId);
  }
  const elementsSchema = isNode ? gs.nodesSchema : gs.edgesSchema;
  const es = elementsSchema.get(elementTypeId);
  if (!es) {
    throw new ElementTypeNotFoundError(elementTypeId);
  }
  return { graphName: gs.name, typeName: es.typeName, labels: es.labels };
}
