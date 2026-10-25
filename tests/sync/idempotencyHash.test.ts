import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger', () => ({ logger: { warn() {}, error() {}, info() {} } }));
import {
  IDEMPOTENCY_KEY_PATTERN,
  markerIdFor,
  requestHashOf,
} from '../../src/middleware/idempotency';

describe('idempotency helpers', () => {
  it('hashes the same request identically regardless of key order', () => {
    const a = requestHashOf('POST', '/v1/transactions', { amount: 1, nested: { b: 2, a: 1 } });
    const b = requestHashOf('POST', '/v1/transactions', { nested: { a: 1, b: 2 }, amount: 1 });
    expect(a).toBe(b);
  });
  it('differs by method, url and body', () => {
    const base = requestHashOf('POST', '/v1/transactions', { amount: 1 });
    expect(requestHashOf('PATCH', '/v1/transactions', { amount: 1 })).not.toBe(base);
    expect(requestHashOf('POST', '/v1/transactions/x', { amount: 1 })).not.toBe(base);
    expect(requestHashOf('POST', '/v1/transactions', { amount: 2 })).not.toBe(base);
    expect(requestHashOf('DELETE', '/v1/transactions/x', undefined)).toBe(
      requestHashOf('DELETE', '/v1/transactions/x', null),
    );
  });
  it('scopes marker ids per user', () => {
    expect(markerIdFor('u1', 'k')).not.toBe(markerIdFor('u2', 'k'));
    expect(markerIdFor('u1', 'k')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('accepts UUIDs and rejects short or unsafe keys', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('3f1b2c4e-8d9a-4b6c-9e0f-1a2b3c4d5e6f')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('short')).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(129))).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('bad key with spaces!!')).toBe(false);
  });
});
