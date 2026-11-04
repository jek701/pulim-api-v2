import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  profile: {} as any,
  saved: undefined as any,
  cancelledReads: 0,
}));
vi.mock('../../src/config/env', () => ({
  env: { NOTIFY_DIGEST_HOUR: 10, NOTIFY_TIMEZONE: 'Asia/Tashkent' },
}));
vi.mock('../../src/repositories/profile.repository', () => ({
  profileRef: (uid: string) => ({ id: uid }),
}));
vi.mock('../../src/db/documents', () => ({
  runSqlTransaction: async (work: any) =>
    work({
      read: async () => ({ exists: state.profile !== null, data: state.profile }),
      save: (_ref: unknown, patch: any) => {
        state.saved = patch;
        state.profile = { ...state.profile, ...patch };
      },
    }),
  readDocument: async () => {
    state.cancelledReads++;
    return { empty: true };
  },
  queryTable: () => ({}),
  filterQuery: (value: unknown) => value,
  limitQuery: (value: unknown) => value,
}));
import { notificationSettingsPatchSchema, profilePatchSchema } from '../../src/domain/schemas';
import {
  patchNotificationSettings,
  notificationDefaults,
  setNotificationsEnabled,
} from '../../src/notifications/settings';
import { normalizePushSettings } from '../../src/push/settings';
import { registerDeviceSchema } from '../../src/push/schemas';

beforeEach(() => {
  state.profile = { notifications: notificationDefaults({}) };
  state.saved = undefined;
  state.cancelledReads = 0;
});
describe('push settings contract', () => {
  it('provides additive defaults for old profiles, with family expenses off', () => {
    expect(normalizePushSettings({ enabled: false })).toEqual({
      enabled: false,
      groups: { money: true, family: true, familyExpenses: false, premium: true, habit: true },
      alsoTelegram: false,
      quietHours: { start: '22:00', end: '08:00' },
      timezone: 'Asia/Tashkent',
    });
  });
  it('keeps enabled-only clients working and cancels pending transactional notifications', async () => {
    const next = await setNotificationsEnabled('one', false);
    expect(next.enabled).toBe(false);
    expect(next.nextDailyAt).toBe(0);
    expect(state.cancelledReads).toBe(1);
    expect(next.groups?.money).toBe(true);
  });
  it('merges partial groups and quiet hours and ignores read-only device status', async () => {
    state.profile.notifications.pushActive = true;
    state.profile.notifications.telegram.status = 'reachable';
    const patch = notificationSettingsPatchSchema.parse({
      groups: { money: false },
      quietHours: { end: '09:15' },
      alsoTelegram: true,
      timezone: 'America/New_York',
      pushActive: false,
    });
    const next = await patchNotificationSettings('one', patch);
    expect(next.groups).toEqual({
      money: false,
      family: true,
      familyExpenses: false,
      premium: true,
      habit: true,
    });
    expect(next.quietHours).toEqual({ start: '22:00', end: '09:15' });
    expect(next.telegram.status).toBe('reachable');
    expect(next.alsoTelegram).toBe(true);
    expect(state.saved.timezone).toBe('America/New_York');
    expect(next).not.toHaveProperty('pushActive');
  });
  it('rejects malformed clocks, groups, languages and timezones', () => {
    for (const value of [
      { quietHours: { start: '24:00' } },
      { quietHours: { end: '8:00' } },
      { quietHours: { end: '12:60' } },
      { timezone: 'Mars/Olympus' },
      { enabled: 'true' },
      { groups: { habit: 1 } },
      { pushActive: true },
    ])
      expect(notificationSettingsPatchSchema.safeParse(value).success).toBe(false);
    expect(profilePatchSchema.safeParse({ language: 'de' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false);
  });
  it('requires a profile for settings changes', async () => {
    state.profile = null;
    await expect(patchNotificationSettings('none', { enabled: true })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
describe('device input validation', () => {
  const body = {
    token: 'ab'.repeat(32),
    platform: 'ios',
    environment: 'production',
    bundleId: 'com.izik.pulim',
    appVersion: '1',
    buildNumber: '1',
    language: 'uz',
    timezone: 'Asia/Tashkent',
  };
  it('normalizes hex and accepts known languages and timezones', () => {
    expect(registerDeviceSchema.parse({ ...body, token: body.token.toUpperCase() }).token).toBe(
      body.token,
    );
    for (const language of ['ru', 'en', 'uz'])
      expect(registerDeviceSchema.safeParse({ ...body, language }).success).toBe(true);
  });
  it('rejects invalid device metadata', () => {
    for (const patch of [
      { token: 'ExpoPushToken[x]' },
      { token: 'ab'.repeat(32) + 'a' },
      { platform: 'android' },
      { environment: 'development' },
      { bundleId: '' },
      { buildNumber: '' },
      { language: 'de' },
      { timezone: 'Mars/Olympus' },
    ])
      expect(registerDeviceSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
});
