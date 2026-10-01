import { describe, expect, it } from 'vitest';
import {
  dateKey,
  isQuietHour,
  nextDailySlot,
  shiftOutOfQuietHours,
} from '../../src/notifications/schedule';

const zone = 'Asia/Tashkent';

describe('notification schedule', () => {
  it('chooses today at 10 before the slot and tomorrow after it', () => {
    expect(new Date(nextDailySlot(Date.parse('2026-09-02T04:00:00Z'), 10, zone)).toISOString())
      .toBe('2026-09-02T05:00:00.000Z');
    expect(new Date(nextDailySlot(Date.parse('2026-09-02T06:00:00Z'), 10, zone)).toISOString())
      .toBe('2026-09-03T05:00:00.000Z');
  });

  it('handles quiet-hour boundaries', () => {
    expect(isQuietHour(Date.parse('2026-09-02T16:59:00Z'), zone, 22, 8)).toBe(false);
    expect(isQuietHour(Date.parse('2026-09-02T17:00:00Z'), zone, 22, 8)).toBe(true);
    expect(isQuietHour(Date.parse('2026-09-03T02:59:00Z'), zone, 22, 8)).toBe(true);
    expect(isQuietHour(Date.parse('2026-09-03T03:00:00Z'), zone, 22, 8)).toBe(false);
  });

  it('moves 23:30 to 08:00 on the next local day', () => {
    const shifted = shiftOutOfQuietHours(Date.parse('2026-09-02T18:30:00Z'), zone, 22, 8);
    expect(new Date(shifted).toISOString()).toBe('2026-09-03T03:00:00.000Z');
    expect(dateKey(shifted, zone)).toBe('2026-09-03');
  });
});
