import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Record<string, number>>(),
  error: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({
  env: { NOTIFY_TIMEZONE: 'Asia/Tashkent' },
  notificationAllowedUids: new Set(),
}));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }),
  documentKey: (_query: unknown, id: string) => ({ id }),
  patchValue: { increment: (amount: number) => ({ increment: amount }) },
  saveDocument: async (ref: { id: string }, patch: Record<string, any>) => {
    const row = mocks.rows.get(ref.id) ?? {};
    for (const [key, value] of Object.entries(patch)) {
      row[key] = typeof value === 'object' ? (row[key] ?? 0) + value.increment : value;
    }
    mocks.rows.set(ref.id, row);
  },
  readDocument: async (ref: { id: string }) => ({ data: mocks.rows.get(ref.id) }),
}));
vi.mock('../../src/utils/logger', () => ({ logger: { error: mocks.error } }));
import { recordDeliveryStat } from '../../src/notifications/queue.repository';

beforeEach(() => {
  mocks.rows.clear();
  mocks.error.mockClear();
});
describe('independent delivery statistics', () => {
  it('keeps native attempts outside the legacy Telegram forbidden-rate denominator', async () => {
    const now = Date.parse('2026-11-04T07:00:00Z');
    for (let attempt = 0; attempt < 100; attempt++) {
      await recordDeliveryStat(true, false, now, 'apns');
    }
    for (let attempt = 0; attempt < 9; attempt++) await recordDeliveryStat(true, false, now);
    await recordDeliveryStat(false, true, now);
    expect(mocks.rows.get('apns:2026-11-04-12')).toMatchObject({
      sent: 100,
      attempts: 100,
      forbidden: 0,
    });
    expect(mocks.rows.get('2026-11-04-12')).toMatchObject({ sent: 9, attempts: 10, forbidden: 1 });
    expect(mocks.error).toHaveBeenCalledWith(
      { attempts: 10, forbidden: 1, hour: '2026-11-04-12' },
      'notify.telegram_forbidden_rate_high',
    );
  });
});
