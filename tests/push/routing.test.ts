import { describe, expect, it } from 'vitest';
import { notificationChannels, quietHoursUntil } from '../../src/push/routing';
import type { NotificationSettings } from '../../src/domain/types';
const settings = {
  enabled: true,
  telegram: { chatId: '1', status: 'reachable' },
} as NotificationSettings;
describe('channel contract and local quiet hours', () => {
  it('keeps Telegram fallback while push is disabled or credentials are missing', () => {
    expect(notificationChannels({ settings, configured: false, activeDevice: true })).toEqual({
      push: false,
      telegram: true,
    });
  });
  it('defaults family expenses off without redirecting them to Telegram', () => {
    expect(
      notificationChannels({
        settings,
        configured: true,
        activeDevice: true,
        group: 'familyExpenses',
      }),
    ).toEqual({ push: false, telegram: false });
  });
  it('suppresses the daily Telegram digest for push users unless both are requested', () => {
    expect(
      notificationChannels({ settings, configured: true, activeDevice: true, digest: true }),
    ).toEqual({ push: false, telegram: false });
    expect(
      notificationChannels({
        settings: { ...settings, alsoTelegram: true },
        configured: true,
        activeDevice: true,
        digest: true,
      }),
    ).toEqual({ push: false, telegram: true });
  });
  it('uses the device timezone and exact minute boundaries', () => {
    const now = Date.parse('2026-11-04T17:30:00Z'); // 22:30 Tashkent, 12:30 New York
    const quiet = { start: '22:30', end: '08:15' };
    expect(quietHoursUntil(now, 'Asia/Tashkent', quiet)).toBe(Date.parse('2026-11-05T03:15:00Z'));
    expect(quietHoursUntil(now, 'America/New_York', quiet)).toBeNull();
    expect(quietHoursUntil(now - 1, 'Asia/Tashkent', quiet)).toBeNull();
  });
  it('supports daytime quiet windows without shifting the wake-up to tomorrow', () => {
    const now = Date.parse('2026-11-04T07:15:00Z');
    expect(quietHoursUntil(now, 'Asia/Tashkent', { start: '12:00', end: '13:30' })).toBe(
      Date.parse('2026-11-04T08:30:00Z'),
    );
    expect(quietHoursUntil(now, 'Asia/Tashkent', { start: '12:00', end: '12:00' })).toBeNull();
  });
  it('crosses a DST transition at local wake-up time', () => {
    const now = Date.parse('2026-03-08T04:00:00Z'); // Mar7 23:00 New York, DST changes overnight
    expect(quietHoursUntil(now, 'America/New_York', { start: '22:00', end: '08:00' })).toBe(
      Date.parse('2026-03-08T12:00:00Z'),
    );
    const fold = Date.parse('2026-11-01T06:10:00Z'); // Second 01:10
    expect(quietHoursUntil(fold, 'America/New_York', { start: '22:00', end: '01:30' })).toBe(
      Date.parse('2026-11-01T06:30:00Z'),
    );
  });
});
