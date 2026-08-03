import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { resolveDate } from '../../src/telegram/resolve/date';

dayjs.extend(utc);
dayjs.extend(timezone);

const tz = 'Asia/Tashkent';
const now = dayjs.tz('2026-08-02 18:00', 'YYYY-MM-DD HH:mm', tz).valueOf();

describe('resolveDate', () => {
  it('uses current time when date is omitted', () => {
    expect(resolveDate('', now).date).toBe(now);
  });

  it('sets an explicit date to noon in Tashkent', () => {
    const result = resolveDate('2026-08-01', now, tz);
    expect(dayjs(result.date).tz(tz).format('YYYY-MM-DD HH:mm')).toBe('2026-08-01 12:00');
  });

  it('does not call today future before noon', () => {
    const morning = dayjs.tz('2026-08-02 08:00', 'YYYY-MM-DD HH:mm', tz).valueOf();
    expect(resolveDate('2026-08-02', morning, tz).ambiguous).toBe(false);
  });

  it('clamps a future date and marks it ambiguous', () => {
    expect(resolveDate('2026-08-03', now, tz)).toEqual({
      date: now, ambiguous: true, reason: 'DATE_IN_FUTURE',
    });
  });

  it('clamps implausibly old dates to one year', () => {
    expect(resolveDate('1970-01-01', now, tz).date).toBe(now - 365 * 86_400_000);
  });

  it('falls back for invalid input', () => {
    expect(resolveDate('not-a-date', now, tz)).toEqual({ date: now, ambiguous: false, reason: null });
  });

  it('preserves a leap day', () => {
    const leapNow = dayjs.tz('2024-03-01 18:00', 'YYYY-MM-DD HH:mm', tz).valueOf();
    const result = resolveDate('2024-02-29', leapNow, tz);
    expect(dayjs(result.date).tz(tz).format('YYYY-MM-DD')).toBe('2024-02-29');
  });
});
