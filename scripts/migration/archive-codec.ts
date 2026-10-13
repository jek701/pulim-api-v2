import { GeoValue, ReferenceValue, Timestamp, type DocumentData } from '../../src/db/values';
import type { RawDocument, RawValue } from './inventory';
import { createHash } from 'node:crypto';

export type TypedValue =
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | { type: 'integer' | 'double' | 'string' | 'bytes' | 'reference'; value: string }
  | { type: 'timestamp'; seconds: string; nanos: number }
  | { type: 'geo'; latitude: number; longitude: number }
  | { type: 'array'; values: TypedValue[] }
  | { type: 'map'; fields: Record<string, TypedValue> };
export interface ArchivedDocument {
  path: string;
  fields: Record<string, TypedValue>;
  createTime?: { seconds: string; nanos: number };
  updateTime?: { seconds: string; nanos: number };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const time = (value: any) => ({
  seconds: String(value.seconds ?? '0'),
  nanos: Number(value.nanos ?? 0),
});

export function archiveValue(raw: RawValue): TypedValue {
  if (Object.hasOwn(raw, 'nullValue') && raw.nullValue != null) return { type: 'null' };
  if (raw.booleanValue != null) return { type: 'boolean', value: raw.booleanValue };
  if (raw.integerValue != null) return { type: 'integer', value: raw.integerValue.toString() };
  if (raw.doubleValue != null)
    return {
      type: 'double',
      value: Object.is(raw.doubleValue, -0) ? '-0' : String(raw.doubleValue),
    };
  if (raw.timestampValue != null) return { type: 'timestamp', ...time(raw.timestampValue) };
  if (raw.stringValue != null) return { type: 'string', value: raw.stringValue };
  if (raw.bytesValue != null)
    return { type: 'bytes', value: Buffer.from(raw.bytesValue as Uint8Array).toString('base64') };
  if (raw.referenceValue != null) return { type: 'reference', value: raw.referenceValue };
  if (raw.geoPointValue != null) {
    const point = raw.geoPointValue as { latitude?: number; longitude?: number };
    return { type: 'geo', latitude: point.latitude ?? 0, longitude: point.longitude ?? 0 };
  }
  if (raw.arrayValue != null)
    return { type: 'array', values: (raw.arrayValue.values ?? []).map(archiveValue) };
  if (raw.mapValue != null)
    return { type: 'map', fields: archiveFields(raw.mapValue.fields ?? {}) };
  throw new Error('UNSUPPORTED_FIRESTORE_VALUE');
}
export function archiveFields(fields: Record<string, RawValue>): Record<string, TypedValue> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, archiveValue(value)]),
  );
}
export function archiveDocument(raw: RawDocument, root: string): ArchivedDocument {
  if (!raw.name?.startsWith(`${root}/`)) throw new Error('INVALID_SOURCE_PATH');
  return {
    path: raw.name.slice(root.length + 1),
    fields: archiveFields(raw.fields ?? {}),
    ...(raw.createTime ? { createTime: time(raw.createTime) } : {}),
    ...(raw.updateTime ? { updateTime: time(raw.updateTime) } : {}),
  };
}
export function runtimeValue(value: TypedValue): any {
  switch (value.type) {
    case 'null':
      return null;
    case 'boolean':
    case 'string':
      return value.value;
    case 'integer': {
      const exact = BigInt(value.value);
      return exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)
        ? exact
        : Number(exact);
    }
    case 'double':
      return Number(value.value);
    case 'timestamp':
      return new Timestamp(Number(value.seconds), value.nanos);
    case 'bytes':
      return Buffer.from(value.value, 'base64');
    case 'reference':
      return new ReferenceValue(value.value);
    case 'geo':
      return new GeoValue(value.latitude, value.longitude);
    case 'array':
      return value.values.map(runtimeValue);
    case 'map':
      return Object.fromEntries(
        Object.entries(value.fields).map(([key, item]) => [key, runtimeValue(item)]),
      );
  }
}
export function runtimeDocument(document: ArchivedDocument): DocumentData {
  return Object.fromEntries(
    Object.entries(document.fields).map(([key, value]) => [key, runtimeValue(value)]),
  );
}
export function typedValue(value: any, hint?: TypedValue): TypedValue {
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
  if (typeof value === 'number')
    return {
      type:
        hint?.type === 'double' || !Number.isSafeInteger(value) || Object.is(value, -0)
          ? 'double'
          : 'integer',
      value: Object.is(value, -0) ? '-0' : String(value),
    };
  if (value instanceof Timestamp)
    return { type: 'timestamp', seconds: String(value.seconds), nanos: value.nanoseconds };
  if (value instanceof Uint8Array)
    return { type: 'bytes', value: Buffer.from(value).toString('base64') };
  if (value instanceof ReferenceValue) return { type: 'reference', value: value.path };
  if (value instanceof GeoValue)
    return { type: 'geo', latitude: value.latitude, longitude: value.longitude };
  if (Array.isArray(value))
    return {
      type: 'array',
      values: value.map((item, i) =>
        typedValue(item, hint?.type === 'array' ? hint.values[i] : undefined),
      ),
    };
  if (value && typeof value === 'object')
    return { type: 'map', fields: typedFields(value, hint?.type === 'map' ? hint.fields : {}) };
  throw new Error('UNSUPPORTED_SQL_VALUE');
}
export function typedFields(
  data: DocumentData,
  hints: Record<string, TypedValue> = {},
): Record<string, TypedValue> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typedValue(value, hints[key])]),
  );
}
export function rawValue(value: TypedValue): RawValue {
  switch (value.type) {
    case 'null':
      return { nullValue: 0 };
    case 'boolean':
      return { booleanValue: value.value };
    case 'integer':
      return { integerValue: value.value };
    case 'double':
      return { doubleValue: Number(value.value) };
    case 'string':
      return { stringValue: value.value };
    case 'timestamp':
      return { timestampValue: { seconds: value.seconds, nanos: value.nanos } };
    case 'bytes':
      return { bytesValue: Buffer.from(value.value, 'base64') };
    case 'reference':
      return { referenceValue: value.value };
    case 'geo':
      return { geoPointValue: { latitude: value.latitude, longitude: value.longitude } };
    case 'array':
      return { arrayValue: { values: value.values.map(rawValue) } };
    case 'map':
      return { mapValue: { fields: rawFields(value.fields) } };
  }
}
export function rawFields(fields: Record<string, TypedValue>): Record<string, RawValue> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, rawValue(value)]));
}
