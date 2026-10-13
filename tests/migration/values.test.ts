import { describe, expect, it } from 'vitest';
import {
  decodeData,
  encodeData,
  GeoValue,
  mergeData,
  patchValue,
  ReferenceValue,
  Timestamp,
  updateData,
} from '../../src/db/values';

describe('reversible SQL document codec', () => {
  it('preserves special types and unknown keys without marker collisions', () => {
    const source = {
      timestamp: new Timestamp(-1, 999999999),
      bytes: Buffer.from([0, 255]),
      reference: new ReferenceValue('projects/p/databases/d/documents/c/id'),
      geo: new GeoValue(41.2, 69.1),
      int64: 9223372036854775807n,
      values: [NaN, Infinity, -Infinity, -0, false, 0, null, {}, []],
      __type: 'timestamp',
      'a/b~c': { unknown: 1 },
      absent: undefined,
    };
    const encoded = encodeData(source);
    const restored = decodeData(encoded.data_json, encoded.types_json);
    expect(restored).toEqual({ ...source, absent: undefined });
    expect(Object.hasOwn(restored, 'absent')).toBe(false);
    expect(restored.timestamp.toMillis()).toBeCloseTo(-0.000001, 5);
    expect(encodeData(restored)).toEqual(encoded);
  });
  it('keeps nested set merge and dotted update semantics distinct', () => {
    const profile = { subscription: { tier: 'premium', trialGrantedAt: 1 }, settings: { a: 1 } };
    expect(mergeData(profile, { subscription: { tier: 'free' } }).subscription).toEqual({
      tier: 'free',
      trialGrantedAt: 1,
    });
    expect(updateData(profile, { subscription: { tier: 'free' } }).subscription).toEqual({
      tier: 'free',
    });
    expect(mergeData(profile, { settings: {} }).settings).toEqual({});
    expect(mergeData({}, { 'stats.seen': 1 })).toEqual({ 'stats.seen': 1 });
    expect(updateData({}, { 'stats.seen': 1 })).toEqual({ stats: { seen: 1 } });
  });
  it('applies deletes, increments and structural array transforms', () => {
    const source = { count: 2, nested: { remove: 'x', retain: 0 }, items: [{ a: 1 }, 1] };
    const changed = updateData(source, {
      count: patchValue.increment(3),
      'nested.remove': patchValue.delete(),
      items: patchValue.arrayUnion({ a: 1 }, false),
    });
    expect(changed).toEqual({ count: 5, nested: { retain: 0 }, items: [{ a: 1 }, 1, false] });
    expect(updateData(changed, { items: patchValue.arrayRemove({ a: 1 }) }).items).toEqual([
      1,
      false,
    ]);
    expect(source.nested.remove).toBe('x');
  });
});
