import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), insert: vi.fn(), patch: vi.fn(), transaction: vi.fn(), send: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({
  isProd: true,
  env: { NOTIFICATIONS_ENABLED: true, LOG_LEVEL: 'silent', NOTIFY_DELIVERY_BATCH: 50,
    NOTIFY_SEND_RATE_PER_SEC: 25, NOTIFY_STALE_AFTER_MS: 21600000 },
  notificationAllowedUids: new Set(['owner']),
  notificationRecipientAllowed: (uid: string) => uid === 'owner',
}));
vi.mock('../../src/db/documents', async (original) => ({
  ...await original<typeof import('../../src/db/documents')>(),
  readDocument: mocks.read, insertDocument: mocks.insert,
  patchDocument: mocks.patch, runSqlTransaction: mocks.transaction,
}));
vi.mock('../../src/telegram/client', () => ({ sendMessage: mocks.send, TelegramApiError: class extends Error {} }));

import { createNotification, listDueNotifications, queueTrialStarted, scheduleBudgetCheck } from '../../src/notifications/queue.repository';
import { runPlanner } from '../../src/notifications/planner';
import { runDelivery } from '../../src/notifications/delivery';

describe('notification owner-only rollout', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ rows: [], empty: true, size: 0 }); });

  it('does not queue another user, including campaigns or budget tasks', async () => {
    expect(await createNotification({ userId: 'other', chatId: '123', type: 'campaign',
      dedupeKey: 'campaign:other', payload: { kind: 'campaign', campaignId: 'c', title: 'Test', body: 'Test' } })).toBe(false);
    expect(await queueTrialStarted('other')).toBe(false);
    await scheduleBudgetCheck('other');
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('can queue an allowed recipient', async () => {
    expect(await createNotification({ userId: 'owner', chatId: '123', type: 'trial_started',
      dedupeKey: 'trial:owner', payload: { kind: 'trial_started', premiumUntil: 123 } })).toBe(true);
    expect(mocks.insert).toHaveBeenCalledOnce();
  });

  it('scopes pending delivery queries to the allowlist before applying the batch limit', async () => {
    await listDueNotifications(Date.now(), 50);
    expect(mocks.read.mock.calls[0]![0].filters).toContainEqual({ field: 'userId', op: 'in', value: ['owner'] });
  });

  it('plans only the allowed profile and leaves other profiles untouched', async () => {
    mocks.read.mockImplementation(async (query) => query.table === 'profiles'
      ? { id: 'owner', exists: true, data: { notifications: { nextDailyAt: Date.now() + 86400000 } } }
      : { rows: [], empty: true, size: 0 });
    await runPlanner();
    const profiles = mocks.read.mock.calls.map(([query]) => query).filter(query => query.table === 'profiles');
    expect(profiles).toEqual([{ table: 'profiles', id: 'owner' }]);
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('blocks delivery even if a disallowed job slips into a result batch', async () => {
    mocks.read.mockImplementation(async (query) => query.filters?.some((f: { field: string }) => f.field === 'nextAttemptAt')
      ? { rows: [{ id: 'job', data: { userId: 'other', staleAt: Date.now() + 86400000 } }], empty: false, size: 1 }
      : { rows: [], empty: true, size: 0 });
    await runDelivery();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
