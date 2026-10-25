import { describe, expect, it } from 'vitest';
import { clientNow } from '../../src/domain/clientTime';

describe('clientNow', () => {
  const now = 1_800_000_000_000;
  it('keeps a plausible client date', () => {
    expect(clientNow(now - 86_400_000, now)).toBe(now - 86_400_000);
    expect(clientNow(now + 60_000, now)).toBe(now + 60_000);
    expect(clientNow(now - 90 * 86_400_000, now)).toBe(now - 90 * 86_400_000);
  });
  it('falls back to server time outside [now-90d, now+5min] or for junk', () => {
    expect(clientNow(now - 91 * 86_400_000, now)).toBe(now);
    expect(clientNow(now + 6 * 60_000, now)).toBe(now);
    for (const junk of [undefined, null, '1', NaN, Infinity, {}]) expect(clientNow(junk, now)).toBe(now);
  });
  it('returns integer milliseconds', () => {
    expect(clientNow(now - 1000.6, now)).toBe(now - 1001);
  });
});
