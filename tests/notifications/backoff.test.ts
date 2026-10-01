import { describe, expect, it } from 'vitest';
import { exhaustedAttempts, retryDelay } from '../../src/notifications/backoff';

describe('notification retry backoff', () => {
  it('grows exponentially and caps at one hour', () => {
    expect(retryDelay(0)).toBe(2_000);
    expect(retryDelay(1)).toBe(4_000);
    expect(retryDelay(30)).toBe(3_600_000);
  });

  it('fails on the configured final attempt', () => {
    expect(exhaustedAttempts(7, 8)).toBe(false);
    expect(exhaustedAttempts(8, 8)).toBe(true);
  });
});
