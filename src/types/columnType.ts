/**
 * ColumnType — the wire-level type tag used in NebulaGraph 5.x's columnar
 * VectorResultTable encoding (see proto/nebula/vector.proto ValueType and
 * internal decode/columnType.go in the reference Go SDK).
 *
 * These numeric values intentionally mirror the byte codes used in the
 * on-wire typeSchema encoding so that `columnTypeCodeMap` in the decoder can
 * be a straight lookup table. Do not renumber without updating the decoder.
 */
export enum ColumnType {
  Node = 0x1,
  Edge = 0x2,
  Unknown = 0x3,
  Bool = 0x4,
  Int8 = 0x5,
  Uint8 = 0x6,
  Int16 = 0x7,
  Uint16 = 0x8,
  Int32 = 0x9,
  Uint32 = 0xa,
  Int64 = 0xb,
  Uint64 = 0xc,
  Float32 = 0xd,
  Float64 = 0xe,
  String = 0x10,
  List = 0x11,
  Path = 0x12,
  Record = 0x13,
  Vector = 0x14, // embedding vector
  LocalTime = 0x15,
  Duration = 0x16,
  Date = 0x17,
  LocalDatetime = 0x18,
  ZonedTime = 0x19,
  ZonedDatetime = 0x20,
  Decimal = 0x22,
  Geography = 0x24,
  Set = 0x25,
  Map = 0x26,
  Any = 0xfe,
  Invalid = 0xff,
}

/** Human-readable name for a ColumnType, used in error messages and debugging. */
export function columnTypeName(t: ColumnType): string {
  switch (t) {
    case ColumnType.Node:
      return 'NODE';
    case ColumnType.Edge:
      return 'EDGE';
    case ColumnType.Unknown:
      return 'UNKNOWN';
    case ColumnType.Bool:
      return 'BOOL';
    case ColumnType.Int8:
      return 'INT8';
    case ColumnType.Uint8:
      return 'UINT8';
    case ColumnType.Int16:
      return 'INT16';
    case ColumnType.Uint16:
      return 'UINT16';
    case ColumnType.Int32:
      return 'INT32';
    case ColumnType.Uint32:
      return 'UINT32';
    case ColumnType.Int64:
      return 'INT64';
    case ColumnType.Uint64:
      return 'UINT64';
    case ColumnType.Float32:
      return 'FLOAT32';
    case ColumnType.Float64:
      return 'FLOAT64';
    case ColumnType.String:
      return 'STRING';
    case ColumnType.List:
      return 'LIST';
    case ColumnType.Path:
      return 'PATH';
    case ColumnType.Record:
      return 'RECORD';
    case ColumnType.Vector:
      return 'EMBEDDINGVECTOR';
    case ColumnType.LocalTime:
      return 'LOCALTIME';
    case ColumnType.Duration:
      return 'DURATION';
    case ColumnType.Date:
      return 'DATE';
    case ColumnType.LocalDatetime:
      return 'LOCALDATETIME';
    case ColumnType.ZonedTime:
      return 'ZONEDTIME';
    case ColumnType.ZonedDatetime:
      return 'ZONEDDATETIME';
    case ColumnType.Decimal:
      return 'DECIMAL';
    case ColumnType.Geography:
      return 'GEOGRAPHY';
    case ColumnType.Set:
      return 'SET';
    case ColumnType.Map:
      return 'MAP';
    case ColumnType.Any:
      return 'ANY';
    default:
      return 'INVALID';
  }
}

/** True for fixed-width scalar column types decoded directly from a byte offset. */
export function isBasicColumnType(t: ColumnType): boolean {
  switch (t) {
    case ColumnType.Bool:
    case ColumnType.Int8:
    case ColumnType.Int16:
    case ColumnType.Int32:
    case ColumnType.Int64:
    case ColumnType.Uint8:
    case ColumnType.Uint16:
    case ColumnType.Uint32:
    case ColumnType.Uint64:
    case ColumnType.Float32:
    case ColumnType.Float64:
    case ColumnType.LocalTime:
    case ColumnType.LocalDatetime:
    case ColumnType.ZonedTime:
    case ColumnType.ZonedDatetime:
    case ColumnType.Date:
    case ColumnType.Duration:
      return true;
    default:
      return false;
  }
}

/** Byte size table for fixed-width column types (see findings-go.md section 5.7). */
export const BASIC_TYPE_SIZE: ReadonlyMap<ColumnType, number> = new Map([
  [ColumnType.Bool, 1],
  [ColumnType.Int8, 1],
  [ColumnType.Uint8, 1],
  [ColumnType.Int16, 2],
  [ColumnType.Uint16, 2],
  [ColumnType.Int32, 4],
  [ColumnType.Uint32, 4],
  [ColumnType.Float32, 4],
  [ColumnType.Date, 4],
  [ColumnType.Int64, 8],
  [ColumnType.Uint64, 8],
  [ColumnType.Float64, 8],
  [ColumnType.LocalTime, 8],
  [ColumnType.ZonedTime, 8],
  [ColumnType.LocalDatetime, 8],
  [ColumnType.ZonedDatetime, 8],
  [ColumnType.Duration, 8],
]);

/** GeoShape enum from proto/nebula/common.proto GeoBase.GeoShape. */
export enum GeoShape {
  PointP = 0,
  PointM = 1,
  PointZ = 2,
  PointZM = 3,
  LineStringL = 4,
  LineStringM = 5,
  LineStringZ = 6,
  LineStringZM = 7,
  PolygonP = 8,
  PolygonM = 9,
  PolygonZ = 10,
  PolygonZM = 11,
}

/**
 * Edge direction as encoded in the high 2 bits of edgeTypeId within an Edge's
 * vector_data header (see findings-go.md section 5.15).
 */
export enum EdgeDirection {
  Outgoing = 0,
  Incoming = 1,
  NoDirection = 2,
}
