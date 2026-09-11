/**
 * Geography value data decoder — decodes the self-contained binary body
 * pointed to by a Geography column's chunk header:
 *   shapeType(1B) + srid(4B) + shape-specific coordinates.
 * See findings-go.md section 5.10.
 */

import { BytesReader } from './bytesReader.js';
import { GeoShape } from '../types/columnType.js';
import type { NebulaGeography, NebulaPoint } from '../types/value.js';

export function decodeGeographyData(r: BytesReader): NebulaGeography {
  const shapeType = r.readInt8();
  const srid = r.readInt32LE();
  const shape = shapeType as GeoShape;

  switch (shape) {
    case GeoShape.PointP:
    case GeoShape.PointM:
    case GeoShape.PointZ:
    case GeoShape.PointZM: {
      const lng = r.readFloat64LE();
      const lat = r.readFloat64LE();
      return { srid, shape, point: { lng, lat } };
    }
    case GeoShape.LineStringL:
    case GeoShape.LineStringM:
    case GeoShape.LineStringZ:
    case GeoShape.LineStringZM: {
      const numCoords = r.readInt32LE();
      const coords: NebulaPoint[] = [];
      for (let i = 0; i < numCoords; i++) {
        const lng = r.readFloat64LE();
        const lat = r.readFloat64LE();
        coords.push({ lng, lat });
      }
      return { srid, shape, lineString: coords };
    }
    case GeoShape.PolygonP:
    case GeoShape.PolygonM:
    case GeoShape.PolygonZ:
    case GeoShape.PolygonZM: {
      const loops = r.readInt32LE();
      const rowIndexes: number[] = [];
      for (let i = 0; i < loops + 1; i++) {
        rowIndexes.push(r.readInt32LE());
      }
      const totalCoords = rowIndexes[loops]!;
      const coords: NebulaPoint[] = [];
      for (let i = 0; i < totalCoords; i++) {
        const lng = r.readFloat64LE();
        const lat = r.readFloat64LE();
        coords.push({ lng, lat });
      }
      const polygonLoops: NebulaPoint[][] = [];
      for (let i = 0; i < loops; i++) {
        const start = rowIndexes[i]!;
        const end = rowIndexes[i + 1]!;
        if (start < end && start < coords.length && end <= coords.length) {
          polygonLoops.push(coords.slice(start, end));
        }
      }
      return { srid, shape, polygon: polygonLoops };
    }
    default:
      throw new Error(`unsupported geography shape: ${shapeType}`);
  }
}

/**
 * Geography flat-vector decoder: 8-byte row header = chunkIndex(4B) +
 * chunkOffset(4B), pointing into nested_vectors[chunkIndex].vector_data.
 */
export function decodeGeographyFlatValue(
  vectorData: Buffer,
  nestedVectors: readonly { vectorData: Buffer }[],
  rowIndex: number,
): NebulaGeography {
  const headerLen = 8;
  const header = vectorData.subarray(rowIndex * headerLen, rowIndex * headerLen + headerLen);
  const chunkIndex = header.readUInt32LE(0);
  const chunkOffset = header.readInt32LE(4);
  const chunk = nestedVectors[chunkIndex];
  if (!chunk) {
    throw new Error(`Geography value: missing nested vector chunk at index ${chunkIndex}`);
  }
  const r = new BytesReader(chunk.vectorData, chunkOffset);
  return decodeGeographyData(r);
}
