/**
 * decodeBasicValue — decodes a fixed-width scalar from a raw byte slice.
 * Mirrors nebula-go's `decodeBasicValue()` (resultTable_helper.go).
 * All multi-byte fields are little-endian.
 */

import {
  bytesToBool,
  bytesToFloat32LE,
  bytesToFloat64LE,
  bytesToInt16LE,
  bytesToInt32LE,
  bytesToInt64LE,
  bytesToInt8,
  bytesToUint16LE,
  bytesToUint32LE,
  bytesToUint64LE,
  bytesToUint8,
} from './bytesReader.js';
import { ColumnType } from '../types/columnType.js';
import type {
  NebulaDate,
  NebulaDuration,
  NebulaLocalDatetime,
  NebulaLocalTime,
  NebulaValueOrNull,
  NebulaZonedDatetime,
  NebulaZonedTime,
} from '../types/value.js';

const MICROSECONDS_OF_SECOND = 1_000_000n;
const MICROSECONDS_OF_MINUTE = 60n * MICROSECONDS_OF_SECOND;
const MICROSECONDS_OF_HOUR = 60n * MICROSECONDS_OF_MINUTE;
const MICROSECONDS_OF_DAY = 24n * MICROSECONDS_OF_HOUR;

/** Unpacks the 64-bit qword shared by LocalDatetime/ZonedDatetime (see
 * findings-go.md section 5.7). Returns fields *before* any timezone shift. */
function unpackDatetimeQword(qword: bigint): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  sec: number;
  microsec: number;
} {
  return {
    year: Number(qword & 0xffffn),
    month: Number((qword >> 16n) & 0xfn),
    day: Number((qword >> 20n) & 0x1fn),
    hour: Number((qword >> 25n) & 0x1fn),
    minute: Number((qword >> 30n) & 0x3fn),
    sec: Number((qword >> 36n) & 0x3fn),
    microsec: Number((qword >> 42n) & 0x3ffffffn),
  };
}

/**
 * Applies a UTC offset (in seconds) to a naive UTC Date built from the given
 * fields, returning the shifted field values plus the microsecond remainder
 * (JS Date has only millisecond resolution, so microseconds are tracked
 * separately and re-added after the shift).
 */
function applyOffsetUtc(
  fields: { year: number; month: number; day: number; hour: number; minute: number; sec: number; microsec: number },
  offsetSec: number,
): { year: number; month: number; day: number; hour: number; minute: number; sec: number; microsec: number } {
  const ms = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.sec,
    Math.floor(fields.microsec / 1000),
  );
  const shifted = new Date(ms + offsetSec * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    sec: shifted.getUTCSeconds(),
    microsec: (fields.microsec % 1000) + shifted.getUTCMilliseconds() * 1000,
  };
}

export function decodeBasicValue(
  bs: Buffer,
  typ: ColumnType,
  timezoneOffsetSec: number,
): NebulaValueOrNull {
  switch (typ) {
    case ColumnType.Bool:
      return { type: ColumnType.Bool, isNull: false, data: bytesToBool(bs, 0) };
    case ColumnType.Int8:
      return { type: ColumnType.Int8, isNull: false, data: bytesToInt8(bs, 0) };
    case ColumnType.Uint8:
      return { type: ColumnType.Uint8, isNull: false, data: bytesToUint8(bs, 0) };
    case ColumnType.Int16:
      return { type: ColumnType.Int16, isNull: false, data: bytesToInt16LE(bs, 0) };
    case ColumnType.Uint16:
      return { type: ColumnType.Uint16, isNull: false, data: bytesToUint16LE(bs, 0) };
    case ColumnType.Int32:
      return { type: ColumnType.Int32, isNull: false, data: bytesToInt32LE(bs, 0) };
    case ColumnType.Uint32:
      return { type: ColumnType.Uint32, isNull: false, data: bytesToUint32LE(bs, 0) };
    case ColumnType.Int64:
      return { type: ColumnType.Int64, isNull: false, data: bytesToInt64LE(bs, 0) };
    case ColumnType.Uint64:
      return { type: ColumnType.Uint64, isNull: false, data: bytesToUint64LE(bs, 0) };
    case ColumnType.Float32:
      return { type: ColumnType.Float32, isNull: false, data: bytesToFloat32LE(bs, 0) };
    case ColumnType.Float64:
      return { type: ColumnType.Float64, isNull: false, data: bytesToFloat64LE(bs, 0) };
    case ColumnType.String:
      return { type: ColumnType.String, isNull: false, data: bs.toString('utf-8') };
    case ColumnType.Decimal:
      return { type: ColumnType.Decimal, isNull: false, data: { sval: bs.toString('utf-8') } };
    case ColumnType.Date: {
      const year = bytesToInt16LE(bs, 0);
      const month = bytesToInt8(bs, 2);
      const day = bytesToInt8(bs, 3);
      const data: NebulaDate = { year, month, day };
      return { type: ColumnType.Date, isNull: false, data };
    }
    case ColumnType.LocalTime: {
      const hour = bytesToInt8(bs, 0);
      const minute = bytesToInt8(bs, 1);
      const sec = bytesToInt8(bs, 2);
      // byte 3 is padding
      const microsec = bytesToInt32LE(bs, 4);
      const data: NebulaLocalTime = { hour, minute, sec, microsec };
      return { type: ColumnType.LocalTime, isNull: false, data };
    }
    case ColumnType.ZonedTime: {
      const hour = bytesToInt8(bs, 0);
      const minute = bytesToInt8(bs, 1);
      const sec = bytesToInt8(bs, 2);
      const microsec = bytesToInt32LE(bs, 4);
      // Reference impl anchors to "today" in the server's local date purely
      // to run the offset shift through a real Date object, then discards
      // the date portion. We do the same using the Unix epoch as the anchor
      // date (arbitrary, only hour/min/sec/microsec survive).
      const shifted = applyOffsetUtc(
        { year: 1970, month: 1, day: 1, hour: Math.abs(hour), minute, sec, microsec },
        timezoneOffsetSec,
      );
      const data: NebulaZonedTime = {
        hour: shifted.hour,
        minute: shifted.minute,
        sec: shifted.sec,
        microsec: shifted.microsec,
        offset: timezoneOffsetSec,
      };
      return { type: ColumnType.ZonedTime, isNull: false, data };
    }
    case ColumnType.LocalDatetime: {
      const qword = bytesToInt64LE(bs, 0);
      const f = unpackDatetimeQword(qword);
      const data: NebulaLocalDatetime = f;
      return { type: ColumnType.LocalDatetime, isNull: false, data };
    }
    case ColumnType.ZonedDatetime: {
      const qword = bytesToInt64LE(bs, 0);
      const f = unpackDatetimeQword(qword);
      const shifted = applyOffsetUtc(f, timezoneOffsetSec);
      const data: NebulaZonedDatetime = { ...shifted, offset: timezoneOffsetSec };
      return { type: ColumnType.ZonedDatetime, isNull: false, data };
    }
    case ColumnType.Duration: {
      const raw = bytesToInt64LE(bs, 0);
      const isMonthBased = (raw & 1n) === 1n;
      const value = raw >> 1n;
      let year = 0;
      let month = 0;
      let day = 0;
      let hour = 0;
      let minute = 0;
      let sec = 0;
      let microsec = 0;
      if (isMonthBased) {
        year = Number(value / 12n);
        month = Number(value % 12n);
      } else {
        day = Number(value / MICROSECONDS_OF_DAY);
        hour = Number((value % MICROSECONDS_OF_DAY) / MICROSECONDS_OF_HOUR);
        minute = Number((value % MICROSECONDS_OF_HOUR) / MICROSECONDS_OF_MINUTE);
        sec = Number((value % MICROSECONDS_OF_MINUTE) / MICROSECONDS_OF_SECOND);
        microsec = Number(value % MICROSECONDS_OF_SECOND);
      }
      const data: NebulaDuration = { isMonthBased, year, month, day, hour, minute, sec, microsec };
      return { type: ColumnType.Duration, isNull: false, data };
    }
    default:
      throw new Error(`decodeBasicValue: unsupported column type ${ColumnType[typ]}`);
  }
}
