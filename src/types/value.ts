/**
 * Value object model for NebulaGraph 5.x query results.
 *
 * The wire format represents values as a columnar VectorResultTable, but this
 * module defines the *decoded*, user-facing representation: a discriminated
 * union `NebulaValue` covering every case in proto/nebula/common.proto's
 * `Value` oneof (33 variants), plus the supporting composite types
 * (Node/Edge/Path/Duration/Date/... /Geography).
 *
 * Design note: the reference Go/Java/Python SDKs expose this as an
 * interface with `AsXxx()` accessor methods that return errors on type
 * mismatch. This TS SDK instead uses a discriminated union
 * (`NebulaValue.type` as the tag) plus small `isXxx`/`asXxx` helper
 * functions, which is more idiomatic in TypeScript and lets consumers use
 * exhaustive `switch` statements safely.
 */

import { ColumnType } from './columnType.js';

/** BigInt-backed 64-bit integer values (Int64/UInt64) to avoid precision loss. */
export type Int64Value = bigint;
export type UInt64Value = bigint;

export interface NebulaDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
}

export interface NebulaLocalTime {
  readonly hour: number;
  readonly minute: number;
  readonly sec: number;
  readonly microsec: number;
}

export interface NebulaZonedTime extends NebulaLocalTime {
  /** Offset from UTC, in seconds. */
  readonly offset: number;
}

export interface NebulaLocalDatetime extends NebulaDate, NebulaLocalTime {}

export interface NebulaZonedDatetime extends NebulaDate, NebulaLocalTime {
  /** Offset from UTC, in seconds. */
  readonly offset: number;
}

export interface NebulaDuration {
  readonly isMonthBased: boolean;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly sec: number;
  readonly microsec: number;
}

export interface NebulaDecimal {
  /** Decimal value represented as its canonical string form, e.g. "3.14". */
  readonly sval: string;
}

export interface NebulaPoint {
  readonly lng: number;
  readonly lat: number;
}

export type NebulaLineString = readonly NebulaPoint[];

/** A polygon is a list of rings (loops); the first ring is the outer boundary. */
export type NebulaPolygon = readonly (readonly NebulaPoint[])[];

export interface NebulaGeography {
  readonly srid: number;
  readonly shape: import('./columnType.js').GeoShape;
  readonly point?: NebulaPoint;
  readonly lineString?: NebulaLineString;
  readonly polygon?: NebulaPolygon;
}

export interface NebulaEmbeddingVector {
  readonly values: readonly number[];
}

export interface NebulaNode {
  readonly nodeId: Int64Value;
  readonly graph: string;
  readonly type: string;
  readonly labels: readonly string[];
  readonly properties: ReadonlyMap<string, NebulaValue>;
}

export interface NebulaEdge {
  readonly srcId: Int64Value;
  readonly dstId: Int64Value;
  readonly direction: import('./columnType.js').EdgeDirection;
  readonly graph: string;
  readonly type: string;
  readonly labels: readonly string[];
  readonly rank: Int64Value;
  readonly properties: ReadonlyMap<string, NebulaValue>;
}

/** A Path alternates Node, Edge, Node, Edge, ..., Node. */
export interface NebulaPath {
  readonly values: readonly NebulaValue[];
}

export interface NebulaList {
  readonly values: readonly NebulaValue[];
}

export interface NebulaSet {
  readonly values: readonly NebulaValue[];
}

export interface NebulaMap {
  readonly entries: ReadonlyMap<NebulaValue, NebulaValue>;
}

export interface NebulaRecord {
  readonly values: ReadonlyMap<string, NebulaValue>;
}

/**
 * Discriminated union over every possible decoded value.
 * `type` corresponds 1:1 with proto Value.Type / ColumnType.
 */
export type NebulaValue =
  | { readonly type: ColumnType.Invalid; readonly isNull: true; readonly data: null }
  | { readonly type: ColumnType.Bool; readonly isNull: false; readonly data: boolean }
  | { readonly type: ColumnType.Int8; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.Uint8; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.Int16; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.Uint16; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.Int32; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.Uint32; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.Int64; readonly isNull: false; readonly data: Int64Value }
  | { readonly type: ColumnType.Uint64; readonly isNull: false; readonly data: UInt64Value }
  | { readonly type: ColumnType.Float32; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.Float64; readonly isNull: false; readonly data: number }
  | { readonly type: ColumnType.String; readonly isNull: false; readonly data: string }
  | { readonly type: ColumnType.List; readonly isNull: false; readonly data: NebulaList }
  | { readonly type: ColumnType.Set; readonly isNull: false; readonly data: NebulaSet }
  | { readonly type: ColumnType.Map; readonly isNull: false; readonly data: NebulaMap }
  | { readonly type: ColumnType.Record; readonly isNull: false; readonly data: NebulaRecord }
  | { readonly type: ColumnType.Node; readonly isNull: false; readonly data: NebulaNode }
  | { readonly type: ColumnType.Edge; readonly isNull: false; readonly data: NebulaEdge }
  | { readonly type: ColumnType.Path; readonly isNull: false; readonly data: NebulaPath }
  | { readonly type: ColumnType.Duration; readonly isNull: false; readonly data: NebulaDuration }
  | { readonly type: ColumnType.LocalTime; readonly isNull: false; readonly data: NebulaLocalTime }
  | { readonly type: ColumnType.ZonedTime; readonly isNull: false; readonly data: NebulaZonedTime }
  | { readonly type: ColumnType.Date; readonly isNull: false; readonly data: NebulaDate }
  | {
      readonly type: ColumnType.LocalDatetime;
      readonly isNull: false;
      readonly data: NebulaLocalDatetime;
    }
  | {
      readonly type: ColumnType.ZonedDatetime;
      readonly isNull: false;
      readonly data: NebulaZonedDatetime;
    }
  | { readonly type: ColumnType.Decimal; readonly isNull: false; readonly data: NebulaDecimal }
  | { readonly type: ColumnType.Vector; readonly isNull: false; readonly data: NebulaEmbeddingVector }
  | { readonly type: ColumnType.Geography; readonly isNull: false; readonly data: NebulaGeography };

/** A NULL value tagged with the column type it would otherwise have held. */
export interface NebulaNullValue {
  readonly type: ColumnType;
  readonly isNull: true;
  readonly data: null;
}

/** Union of a concrete decoded value or a typed NULL. */
export type NebulaValueOrNull = NebulaValue | NebulaNullValue;

export function nullValue(type: ColumnType): NebulaNullValue {
  return { type, isNull: true, data: null };
}

/** Type guard + accessor helpers (idiomatic alternative to Go's AsXxx() error-returning API). */
export function isNull(v: NebulaValueOrNull): v is NebulaNullValue {
  return v.isNull;
}

export class NebulaTypeError extends Error {
  constructor(expected: ColumnType, actual: ColumnType) {
    super(`expected value of type ${ColumnType[expected]}, got ${ColumnType[actual]}`);
    this.name = 'NebulaTypeError';
  }
}

function assertType<T extends NebulaValue>(
  v: NebulaValueOrNull,
  type: T['type'],
): T {
  if (v.isNull) {
    throw new NebulaTypeError(type, v.type);
  }
  if (v.type !== type) {
    throw new NebulaTypeError(type, v.type);
  }
  return v as unknown as T;
}

export const asBool = (v: NebulaValueOrNull): boolean =>
  assertType<Extract<NebulaValue, { type: ColumnType.Bool }>>(v, ColumnType.Bool).data;
export const asInt64 = (v: NebulaValueOrNull): Int64Value =>
  assertType<Extract<NebulaValue, { type: ColumnType.Int64 }>>(v, ColumnType.Int64).data;
export const asFloat64 = (v: NebulaValueOrNull): number =>
  assertType<Extract<NebulaValue, { type: ColumnType.Float64 }>>(v, ColumnType.Float64).data;
export const asString = (v: NebulaValueOrNull): string =>
  assertType<Extract<NebulaValue, { type: ColumnType.String }>>(v, ColumnType.String).data;
export const asNode = (v: NebulaValueOrNull): NebulaNode =>
  assertType<Extract<NebulaValue, { type: ColumnType.Node }>>(v, ColumnType.Node).data;
export const asEdge = (v: NebulaValueOrNull): NebulaEdge =>
  assertType<Extract<NebulaValue, { type: ColumnType.Edge }>>(v, ColumnType.Edge).data;
export const asPath = (v: NebulaValueOrNull): NebulaPath =>
  assertType<Extract<NebulaValue, { type: ColumnType.Path }>>(v, ColumnType.Path).data;
export const asList = (v: NebulaValueOrNull): NebulaList =>
  assertType<Extract<NebulaValue, { type: ColumnType.List }>>(v, ColumnType.List).data;
export const asSet = (v: NebulaValueOrNull): NebulaSet =>
  assertType<Extract<NebulaValue, { type: ColumnType.Set }>>(v, ColumnType.Set).data;
export const asMap = (v: NebulaValueOrNull): NebulaMap =>
  assertType<Extract<NebulaValue, { type: ColumnType.Map }>>(v, ColumnType.Map).data;
export const asRecord = (v: NebulaValueOrNull): NebulaRecord =>
  assertType<Extract<NebulaValue, { type: ColumnType.Record }>>(v, ColumnType.Record).data;

/**
 * Convert a decoded value into a plain JS representation
 * (numbers/strings/arrays/objects/Map), recursively unwrapping composite
 * types. Int64/UInt64 remain `bigint` to avoid precision loss.
 * Mirrors `cast_primitive()` in nebula-python / `as_primitive()` semantics.
 */
export function toPrimitive(v: NebulaValueOrNull): unknown {
  if (v.isNull) return null;
  switch (v.type) {
    case ColumnType.Bool:
    case ColumnType.Int8:
    case ColumnType.Uint8:
    case ColumnType.Int16:
    case ColumnType.Uint16:
    case ColumnType.Int32:
    case ColumnType.Uint32:
    case ColumnType.Float32:
    case ColumnType.Float64:
    case ColumnType.String:
    case ColumnType.Int64:
    case ColumnType.Uint64:
      return v.data;
    case ColumnType.List:
      return v.data.values.map(toPrimitive);
    case ColumnType.Set:
      return v.data.values.map(toPrimitive);
    case ColumnType.Map: {
      const out = new Map<unknown, unknown>();
      for (const [k, val] of v.data.entries) out.set(toPrimitive(k), toPrimitive(val));
      return out;
    }
    case ColumnType.Record: {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.data.values) out[k] = toPrimitive(val);
      return out;
    }
    case ColumnType.Node: {
      const props: Record<string, unknown> = {};
      for (const [k, val] of v.data.properties) props[k] = toPrimitive(val);
      return {
        nodeId: v.data.nodeId,
        graph: v.data.graph,
        type: v.data.type,
        labels: v.data.labels,
        properties: props,
      };
    }
    case ColumnType.Edge: {
      const props: Record<string, unknown> = {};
      for (const [k, val] of v.data.properties) props[k] = toPrimitive(val);
      return {
        srcId: v.data.srcId,
        dstId: v.data.dstId,
        direction: v.data.direction,
        graph: v.data.graph,
        type: v.data.type,
        labels: v.data.labels,
        rank: v.data.rank,
        properties: props,
      };
    }
    case ColumnType.Path:
      return v.data.values.map(toPrimitive);
    case ColumnType.Decimal:
      return v.data.sval;
    case ColumnType.Vector:
      return v.data.values;
    default:
      return v.data;
  }
}
