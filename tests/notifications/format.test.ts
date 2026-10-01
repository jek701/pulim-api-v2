import { describe, expect, it } from 'vitest';
import { formatMoney, pluralDays, safe } from '../../src/notifications/format';

describe('notification formatting', () => {
  it('uses non-breaking digit separators', () => {
    expect(formatMoney(1_234_567, 'UZS', 'ru')).toBe('1\u00a0234\u00a0567 сум');
  });

  it('declines Russian days', () => {
    expect(pluralDays(1, 'ru')).toContain('день');
    expect(pluralDays(2, 'ru')).toContain('дня');
    expect(pluralDays(12, 'ru')).toContain('дней');
  });

  it('escapes Telegram HTML', () => {
    expect(safe('<Food & Co>')).toBe('&lt;Food &amp; Co&gt;');
  });
});
