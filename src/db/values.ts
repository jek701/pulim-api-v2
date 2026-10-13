import { isDeepStrictEqual } from 'node:util';

export type DocumentData = Record<string, any>;
export class Timestamp {
  constructor(
    readonly seconds: number,
    readonly nanoseconds: number,
  ) {
    if (
      !Number.isSafeInteger(seconds) ||
      !Number.isInteger(nanoseconds) ||
      nanoseconds < 0 ||
      nanoseconds >= 1e9
    ) {
      throw new Error('Invalid timestamp');
    }
  }
  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.floor((ms - seconds * 1000) * 1e6));
  }
  toMillis(): number {
    return this.seconds * 1000 + this.nanoseconds / 1e6;
  }
  toJSON(): { _seconds: number; _nanoseconds: number } {
    return { _seconds: this.seconds, _nanoseconds: this.nanoseconds };
  }
}
export class ReferenceValue {
  constructor(readonly path: string) {}
}
export class GeoValue {
  constructor(
    readonly latitude: number,
    readonly longitude: number,
  ) {}
}

class Transform {
  constructor(
    readonly kind: 'delete' | 'increment' | 'union' | 'remove',
    readonly args: unknown[],
  ) {}
}
export const patchValue = {
  delete: () => new Transform('delete', []),
  increment: (amount: number) => new Transform('increment', [amount]),
  arrayUnion: (...values: unknown[]) => new Transform('union', values),
  arrayRemove: (...values: unknown[]) => new Transform('remove', values),
};
const plain = (value: unknown): value is DocumentData =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value: DocumentData, key: string) =>
  Object.hasOwn(value, key) ? value[key] : undefined;
function assign(target: DocumentData, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
function resolved(old: unknown, value: unknown): unknown {
  if (!(value instanceof Transform)) return value;
  if (value.kind === 'increment')
    return (typeof old === 'number' ? old : 0) + Number(value.args[0]);
  const array = Array.isArray(old) ? [...old] : [];
  if (value.kind === 'union') {
    for (const item of value.args)
      if (!array.some((present) => isDeepStrictEqual(present, item))) array.push(item);
    return array;
  }
  if (value.kind === 'remove')
    return array.filter((item) => !value.args.some((removed) => isDeepStrictEqual(item, removed)));
  return value;
}

/** Merge maps recursively; dotted keys in a set remain literal, empty maps replace. */
export function mergeData(current: DocumentData, patch: DocumentData): DocumentData {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value instanceof Transform && value.kind === 'delete') {
      delete result[key];
      continue;
    }
    const old = own(current, key);
    assign(
      result,
      key,
      plain(value) && Object.keys(value).length
        ? mergeData(plain(old) ? old : {}, value)
        : resolved(old, value),
    );
  }
  return result;
}

/** Update replaces map values; field paths are interpreted only for update. */
export function updateData(current: DocumentData, patch: DocumentData): DocumentData {
  const result = { ...current };
  for (const [path, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const parts = path.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) {
      const old = own(target, part);
      const child = plain(old) ? { ...old } : {};
      assign(target, part, child);
      target = child;
    }
    const key = parts.at(-1)!;
    if (value instanceof Transform && value.kind === 'delete') delete target[key];
    else assign(target, key, resolved(own(target, key), value));
  }
  return result;
}

/** Sidecar type paths avoid collisions with arbitrary legacy JSON keys. */
export function encodeData(data: DocumentData): { data_json: string; types_json: string } {
  const types: Record<string, string> = Object.create(null);
  function encode(value: any, path: string): any {
    if (value instanceof Transform) throw new Error('Unresolved storage transform');
    if (value instanceof Timestamp) {
      types[path] = 'timestamp';
      return [value.seconds, value.nanoseconds];
    }
    if (value instanceof ReferenceValue) {
      types[path] = 'reference';
      return value.path;
    }
    if (value instanceof GeoValue) {
      types[path] = 'geo';
      return [value.latitude, value.longitude];
    }
    if (value instanceof Uint8Array) {
      types[path] = 'bytes';
      return Buffer.from(value).toString('base64');
    }
    if (typeof value === 'bigint') {
      types[path] = 'int64';
      return value.toString();
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      types[path] = 'double';
      return String(value);
    }
    if (Object.is(value, -0)) {
      types[path] = 'negative-zero';
      return 0;
    }
    if (Array.isArray(value))
      return value.map((item, i) => {
        if (item === undefined) throw new Error('Undefined array value');
        return encode(item, `${path}/${i}`);
      });
    if (plain(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((key) => value[key] !== undefined)
          .map((key) => [
            key,
            encode(value[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`),
          ]),
      );
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    throw new Error('Unsupported document value');
  }
  return { data_json: JSON.stringify(encode(data, '')), types_json: JSON.stringify(types) };
}
export function decodeData(
  json: string | DocumentData,
  typeJson: string | Record<string, string>,
): DocumentData {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const types = typeof typeJson === 'string' ? JSON.parse(typeJson) : typeJson;
  function decode(value: any, path: string): any {
    switch (types[path]) {
      case 'timestamp':
        return new Timestamp(value[0], value[1]);
      case 'reference':
        return new ReferenceValue(value);
      case 'geo':
        return new GeoValue(value[0], value[1]);
      case 'bytes':
        return Buffer.from(value, 'base64');
      case 'int64':
        return BigInt(value);
      case 'double':
        return Number(value);
      case 'negative-zero':
        return -0;
    }
    if (Array.isArray(value)) return value.map((item, i) => decode(item, `${path}/${i}`));
    if (plain(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          decode(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`),
        ]),
      );
    return value;
  }
  return decode(data, '');
}
