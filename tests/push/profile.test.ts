import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), active: vi.fn() }));
vi.mock('../../src/repositories/profile.repository', () => ({
  getProfile: mocks.get,
  profileRef: (uid: string) => ({ id: uid }),
}));
vi.mock('../../src/push/devices.repository', () => ({ pushActive: mocks.active }));
vi.mock('../../src/notifications/settings', () => ({
  ensureNotificationDefaults: async () => undefined,
}));
vi.mock('../../src/notifications/queue.repository', () => ({
  queueTrialStarted: async () => undefined,
}));
import { profileWithPushStatus } from '../../src/services/profile.service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.active.mockResolvedValue(false);
});
describe('profile push status response', () => {
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
