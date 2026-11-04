import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedNotification } from '../../src/notifications/types';
import type { PushDevice } from '../../src/push/devices.repository';

const mocks = vi.hoisted(() => ({
  allowed: new Set(['owner']),
  job: undefined as QueuedNotification | undefined,
  profile: vi.fn(),
  devices: vi.fn(),
  configured: vi.fn(),
  sendApns: vi.fn(),
  disableDevice: vi.fn(),
  sendTelegram: vi.fn(),
  saveMessage: vi.fn(),
  unavailable: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  claim: vi.fn(),
  defer: vi.fn(),
  finish: vi.fn(),
  retry: vi.fn(),
  sent: vi.fn(),
  channel: vi.fn(),
  stat: vi.fn(),
  recover: vi.fn(),
  relevant: vi.fn(),
  budgets: vi.fn(),
  campaign: vi.fn(),
  latency: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({
  env: {
    NOTIFICATIONS_ENABLED: true,
    BACKGROUND_JOBS_ENABLED: true,
    MAINTENANCE_MODE: false,
    NOTIFY_DELIVERY_BATCH: 50,
    NOTIFY_SEND_RATE_PER_SEC: Infinity,
    NOTIFY_MAX_ATTEMPTS: 8,
  },
  notificationRecipientAllowed: (uid: string) => mocks.allowed.has(uid),
}));
vi.mock('../../src/repositories/profile.repository', () => ({ getProfile: mocks.profile }));
vi.mock('../../src/push/devices.repository', () => ({
  enabledDevices: mocks.devices,
  disableDevice: mocks.disableDevice,
}));
vi.mock('../../src/push/apns', async (original) => ({
  ...(await original<typeof import('../../src/push/apns')>()),
  apnsConfigured: mocks.configured,
  sendApns: mocks.sendApns,
}));
vi.mock('../../src/push/planner', () => ({ scheduledStillRelevant: mocks.relevant }));
vi.mock('../../src/notifications/planner', () => ({ runBudgetChecks: mocks.budgets }));
vi.mock('../../src/push/latency', () => ({ recordPushLatency: mocks.latency }));
vi.mock('../../src/telegram/client', () => ({
  sendMessage: mocks.sendTelegram,
  TelegramApiError: class extends Error {},
}));
vi.mock('../../src/telegram/messages.repository', () => ({ saveMessage: mocks.saveMessage }));
vi.mock('../../src/notifications/settings', () => ({ markTelegramUnavailable: mocks.unavailable }));
vi.mock('../../src/notifications/render/blocks', () => ({
  renderNotification: () => ({
    text: 'Rendered notification',
    keyboard: { inline_keyboard: [] },
    items: [],
  }),
}));
vi.mock('../../src/communications/repository', () => ({
  markCampaignTelegramOutcome: mocks.campaign,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/notifications/queue.repository', () => ({
  claimNotification: mocks.claim,
  deferNotification: mocks.defer,
  finishNotification: mocks.finish,
  markNotificationSent: mocks.sent,
  recordDeliveryStat: mocks.stat,
  recoverExpiredLeases: mocks.recover,
  releaseSafetySlot: mocks.release,
  reserveSafetySlot: mocks.reserve,
  retryNotification: mocks.retry,
  recordChannelDelivery: mocks.channel,
  listDueNotifications: async (now: number) =>
    mocks.job?.status === 'pending' && mocks.job.nextAttemptAt <= now
      ? [structuredClone(mocks.job)]
      : [],
}));
import { runDelivery } from '../../src/notifications/delivery';

const NOW = Date.parse('2026-11-04T07:00:00Z'); // Noon in Tashkent.
function device(id: string): PushDevice {
  return {
    id,
    uid: 'owner',
    token: id.repeat(64),
    platform: 'ios',
    environment: 'sandbox',
    bundleId: 'com.izik.pulim',
    appVersion: '1',
    buildNumber: '1',
    createdAt: NOW,
    lastSeenAt: NOW,
    disabledAt: null,
    disabledReason: null,
  };
}
function profile(telegram = false, alsoTelegram = false) {
  return {
    id: 'owner',
    language: 'ru',
    timezone: 'Asia/Tashkent',
    notifications: {
      enabled: true,
      groups: { money: true, family: true, familyExpenses: false, premium: true, habit: true },
      quietHours: { start: '22:00', end: '08:00' },
      alsoTelegram,
      telegram: { chatId: telegram ? '123' : null, status: 'reachable' },
      introSentAt: 1,
    },
  };
}
function notification(now = NOW): QueuedNotification {
  return {
    id: 'job',
    userId: 'owner',
    chatId: '',
    type: 'budget_80',
    dedupeKey: 'budget:owner:food:80:2026-11',
    status: 'pending',
    runAt: now,
    staleAt: now + 86400000,
    deferredUntil: null,
    nextAttemptAt: now,
    leaseUntil: null,
    attempts: 0,
    lastError: null,
    skipReason: null,
    payload: {
      kind: 'budget',
      categoryId: 'food',
      categoryName: 'Еда',
      spent: 80,
      budget: 100,
      threshold: 80,
    },
    stateKeys: [],
    stateEffects: {},
    messageId: null,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  mocks.allowed.clear();
  mocks.allowed.add('owner');
  mocks.job = notification();
  mocks.profile.mockResolvedValue(profile());
  mocks.devices.mockResolvedValue([device('a')]);
  mocks.configured.mockReturnValue(true);
  mocks.sendApns.mockResolvedValue({ status: 200 });
  mocks.sendTelegram.mockResolvedValue({ message_id: 42 });
  mocks.saveMessage.mockResolvedValue(undefined);
  mocks.relevant.mockResolvedValue(true);
  mocks.budgets.mockResolvedValue(undefined);
  mocks.recover.mockResolvedValue(0);
  mocks.reserve.mockResolvedValue('ok');
  mocks.release.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue(undefined);
  mocks.claim.mockImplementation(async (id: string) => {
    if (mocks.job?.id !== id || mocks.job.status !== 'pending') return null;
    mocks.job.status = 'sending';
    mocks.job.attempts++;
    return structuredClone(mocks.job);
  });
  mocks.channel.mockImplementation(async (_claimed, deviceId?: string, messageId?: number) => {
    const job = mocks.job!;
    job.safetyCounted = true;
    if (deviceId) job.deliveredDevices = [...(job.deliveredDevices ?? []), deviceId];
    else {
      job.telegramDelivered = true;
      job.messageId = messageId!;
    }
  });
  mocks.retry.mockImplementation(async (_id, retryAt: number, error: string) => {
    Object.assign(mocks.job!, { status: 'pending', nextAttemptAt: retryAt, lastError: error });
  });
  mocks.sent.mockImplementation(async () => {
    mocks.job!.status = 'sent';
  });
  mocks.finish.mockImplementation(
    async (_id, status: QueuedNotification['status'], reason: string) => {
      Object.assign(mocks.job!, { status, skipReason: reason });
    },
  );
  mocks.defer.mockImplementation(async (_id, until: number) => {
    Object.assign(mocks.job!, { status: 'pending', nextAttemptAt: until, deferredUntil: until });
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('delivery channel integration with mocked I/O', () => {
  it('sends native push to a user without a Telegram chat and records the channel before completion', async () => {
    expect(await runDelivery()).toBe(1);
    expect(mocks.job!.status).toBe('sent');
    expect(mocks.sendApns).toHaveBeenCalledWith(
      device('a'),
      expect.objectContaining({
        type: 'budget_80',
        link: '/budgets/food',
        notificationId: 'job',
        aps: expect.objectContaining({ 'thread-id': 'money', 'interruption-level': 'active' }),
      }),
      expect.objectContaining({ collapseId: expect.stringMatching(/^budget:[a-f0-9]{48}$/) }),
    );
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
    expect(mocks.channel).toHaveBeenCalledWith(expect.objectContaining({ id: 'job' }), 'a');
    expect(mocks.channel.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sent.mock.invocationCallOrder[0],
    );
    expect(mocks.latency).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'budget_80', enqueuedAt: NOW, status: 200 }),
    );
  });
  it('enforces the rollout allowlist before claiming or sending', async () => {
    mocks.job!.userId = 'not-allowed';
    await runDelivery();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.sendApns).not.toHaveBeenCalled();
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });
  it('suppresses a disabled notification group for both channels', async () => {
    const user = profile(true, true);
    user.notifications.groups.money = false;
    mocks.profile.mockResolvedValue(user);
    await runDelivery();
    expect(mocks.finish).toHaveBeenCalledWith('job', 'skipped', 'disabled');
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.sendApns).not.toHaveBeenCalled();
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });
  it('keeps Telegram opt-in when push is active', async () => {
    mocks.profile.mockResolvedValue(profile(true));
    await runDelivery();
    expect(mocks.sendApns).toHaveBeenCalledOnce();
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });
  it('sends and acknowledges both channels when alsoTelegram is enabled', async () => {
    mocks.profile.mockResolvedValue(profile(true, true));
    await runDelivery();
    expect(mocks.sendApns).toHaveBeenCalledOnce();
    expect(mocks.sendTelegram).toHaveBeenCalledWith(
      '123',
      'Rendered notification',
      expect.any(Object),
    );
    expect(mocks.channel).toHaveBeenCalledTimes(2);
    expect(mocks.channel).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'job' }),
      undefined,
      42,
    );
    expect(mocks.sent).toHaveBeenCalledWith(expect.objectContaining({ id: 'job' }), 42, false);
  });
  it('falls back to Telegram when APNs is unconfigured', async () => {
    mocks.profile.mockResolvedValue(profile(true));
    mocks.configured.mockReturnValue(false);
    await runDelivery();
    expect(mocks.devices).not.toHaveBeenCalled();
    expect(mocks.sendApns).not.toHaveBeenCalled();
    expect(mocks.sendTelegram).toHaveBeenCalledOnce();
  });
  it('defers ordinary pushes until the end of local quiet hours', async () => {
    const night = Date.parse('2026-11-04T18:00:00Z');
    vi.setSystemTime(night);
    mocks.job = notification(night);
    await runDelivery();
    expect(mocks.defer).toHaveBeenCalledWith('job', Date.parse('2026-11-05T03:00:00Z'));
    expect(mocks.sendApns).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('bypasses local quiet hours only for time-sensitive budget exceeded pushes', async () => {
    const night = Date.parse('2026-11-04T18:00:00Z');
    vi.setSystemTime(night);
    mocks.job = notification(night);
    mocks.job.type = 'budget_100';
    if (mocks.job.payload.kind === 'budget') mocks.job.payload.threshold = 100;
    await runDelivery();
    expect(mocks.defer).not.toHaveBeenCalled();
    expect(mocks.sendApns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'budget_100',
        aps: expect.objectContaining({ 'interruption-level': 'time-sensitive' }),
      }),
      expect.anything(),
    );
    expect(mocks.job.status).toBe('sent');
  });
  it('retries APNs throttling and does not resend an already acknowledged sibling device', async () => {
    mocks.devices.mockResolvedValue([device('a'), device('b')]);
    mocks.sendApns
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 429, reason: 'TooManyRequests' });
    await runDelivery();
    expect(mocks.retry).toHaveBeenCalledWith('job', NOW + 4000, 'APNs:429:TooManyRequests');
    expect(mocks.job).toMatchObject({
      status: 'pending',
      safetyCounted: true,
      deliveredDevices: ['a'],
    });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.sent).not.toHaveBeenCalled();
    vi.setSystemTime(mocks.job!.nextAttemptAt);
    await runDelivery();
    expect(mocks.sendApns.mock.calls.map(([target]) => target.id)).toEqual(['a', 'b', 'b']);
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.job!.deliveredDevices).toEqual(['a', 'b']);
    expect(mocks.job!.status).toBe('sent');
  });
  it('disables invalid tokens without retrying a healthy sibling device', async () => {
    mocks.devices.mockResolvedValue([device('a'), device('b')]);
    mocks.sendApns
      .mockResolvedValueOnce({ status: 410, reason: 'Unregistered' })
      .mockResolvedValueOnce({ status: 200 });
    await runDelivery();
    expect(mocks.disableDevice).toHaveBeenCalledWith('a', 'Unregistered', NOW);
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.job!.status).toBe('sent');
    expect(mocks.job!.deliveredDevices).toEqual(['b']);
  });
  it('skips scheduled reminders whose source is no longer relevant', async () => {
    mocks.job!.pushOnly = true;
    mocks.relevant.mockResolvedValue(false);
    await runDelivery();
    expect(mocks.finish).toHaveBeenCalledWith('job', 'skipped', 'no_longer_relevant');
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.sendApns).not.toHaveBeenCalled();
  });
  it('rechecks scheduled reminders before sending and reserves the habit safety slot', async () => {
    mocks.job!.pushOnly = true;
    mocks.job!.payload = {
      kind: 'push',
      type: 'evening_log',
      group: 'habit',
      link: '/(tabs)',
      values: {},
      eventAt: NOW,
    };
    await runDelivery();
    expect(mocks.relevant).toHaveBeenCalledOnce();
    expect(mocks.reserve).toHaveBeenCalledWith('owner', NOW, false, true);
  });
});
