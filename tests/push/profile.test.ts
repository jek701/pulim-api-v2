import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), active: vi.fn(), merge: vi.fn() }));
vi.mock('../../src/repositories/profile.repository', () => ({
  getProfile: mocks.get,
  mergeProfile: mocks.merge,
  profileRef: (uid: string) => ({ id: uid }),
}));
vi.mock('../../src/push/devices.repository', () => ({ pushActive: mocks.active }));
vi.mock('../../src/notifications/settings', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/notifications/settings')>(),
  ensureNotificationDefaults: async () => undefined,
}));
vi.mock('../../src/services/household.service', () => ({ syncMemberName: vi.fn() }));
vi.mock('../../src/notifications/queue.repository', () => ({
  queueTrialStarted: async () => undefined,
}));
import { profileWithPushStatus } from '../../src/services/profile.service';
import { notificationDefaults } from '../../src/notifications/settings';
import { getProfileHandler, patchProfile } from '../../src/controllers/profile.controller';
import type { RequestHandler } from 'express';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.active.mockResolvedValue(false);
});
describe('profile push status response', () => {
  it.each([['GET', getProfileHandler], ['PATCH', patchProfile]] as const)(
    '%s profile returns a superset of every legacy notification default for an old profile', async (_method, handler: RequestHandler) => {
      const profile = { id: 'one', telegramChatIds: ['123'] };
      mocks.get.mockResolvedValue(profile);
      const result = await new Promise<any>((resolve, reject) => {
        handler({ uid: 'one', body: {} } as any, { json: resolve } as any, reject);
      });
      const defaults = notificationDefaults(profile);
      for (const key of Object.keys(defaults)) expect(result.notifications).toHaveProperty(key);
      expect(result.notifications.telegram).toEqual({ chatId: '123', status: 'unknown', lastError: null, checkedAt: 0 });
      expect(result.notifications).toMatchObject({ enabled: true, sentCount: 0, sentDay: '', introSentAt: null, lastSentAt: null });
      expect(profile).not.toHaveProperty('notifications');
    },
  );

  it('preserves stored legacy fields and fills missing Telegram fields', async () => {
    mocks.get.mockResolvedValue({ id: 'one', telegramChatIds: ['123'], notifications: {
      telegram: { status: 'reachable', checkedAt: 100 }, nextDailyAt: 55, introSentAt: 12,
      sentCount: 3, sentDay: '2026-11-04', lastSentAt: 50,
    } });
    expect((await profileWithPushStatus('one'))?.notifications).toMatchObject({
      telegram: { chatId: '123', status: 'reachable', lastError: null, checkedAt: 100 },
      nextDailyAt: 55, introSentAt: 12, sentCount: 3, sentDay: '2026-11-04', lastSentAt: 50,
    });
  });

  it('adds defaults to old profiles and computes live status without mutating stored settings', async () => {
    const profile = {
      id: 'one',
      timezone: 'Europe/London',
      notifications: { enabled: false, pushActive: false },
    };
    mocks.get.mockResolvedValue(profile);
    mocks.active.mockResolvedValue(true);
    const result = await profileWithPushStatus('one');
    expect(result?.notifications).toMatchObject({
      enabled: false,
      pushActive: true,
      timezone: 'Europe/London',
      groups: { money: true, family: true, familyExpenses: false, premium: true, habit: true },
      alsoTelegram: false,
      quietHours: { start: '22:00', end: '08:00' },
    });
    expect(profile.notifications).toEqual({ enabled: false, pushActive: false });
    expect(mocks.active).toHaveBeenCalledWith('one');
  });
  it('returns no profile without querying devices when the profile is absent', async () => {
    mocks.get.mockResolvedValue(null);
    expect(await profileWithPushStatus('missing')).toBeNull();
    expect(mocks.active).not.toHaveBeenCalled();
  });
});
