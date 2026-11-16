import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  records: new Map<string, any>(),
  tail: Promise.resolve() as Promise<unknown>,
  devices: true,
  statusRows: [] as any[],
}));
vi.mock('../../src/config/env', () => ({
  env: {
    NOTIFICATIONS_ENABLED: true,
    PUSH_ENABLED: true,
    NOTIFY_SAFETY_MAX_PER_USER_PER_DAY: 6,
    NOTIFY_STALE_AFTER_MS: 86400000,
    NOTIFY_DIGEST_HOUR: 10,
    NOTIFY_TIMEZONE: 'Asia/Tashkent',
  },
  notificationAllowedUids: new Set(),
  notificationRecipientAllowed: () => true,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/db/documents', async () => (await import('./helpers')).documentMock(state));
vi.mock('../../src/push/devices.repository', () => ({
  enabledDevices: async () => (state.devices ? [{ id: 'device' }] : []),
}));
vi.mock('../../src/db/database', () => ({
  database: () => ({
    selectFrom: () => {
      const chain: any = {
        select: () => chain,
        where: () => chain,
        execute: async () => state.statusRows,
      };
      return chain;
    },
  }),
}));
import {
  queueCrmMessage,
  crmMessageKey,
  crmMessageStatuses,
  crmStatus,
} from '../../src/crm/messages';
import { crmMessageBody, crmUsersQuery, crmFactsBody, crmStatusBody } from '../../src/crm/schemas';
const now = Date.parse('2026-11-16T07:00:00Z');
const input = () =>
  crmMessageBody.parse({
    mid: 'message-1',
    uid: 'user',
    channel: 'push',
    category: 'marketing',
    title: 'Hello {literal}',
    body: 'Already localised',
    link: '/premium',
    collapseKey: 'journey',
  });
const user = () => state.records.get('profiles/user');
const job = () => state.records.get(`notifications/${crmMessageKey('message-1')}`);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  state.records.clear();
  state.tail = Promise.resolve();
  state.devices = true;
  state.statusRows = [];
  state.records.set('profiles/user', {
    linkedAuthMethods: ['apple'],
    updatedAt: 1,
    notifications: {
      enabled: true,
      groups: { tips: true },
      timezone: 'Asia/Tashkent',
      quietHours: { start: '22:00', end: '08:00' },
    },
  });
});
afterEach(() => vi.useRealTimers());
describe('CRM push admission and durable outcomes', () => {
  it.each(['absent', 'anonymous', 'deleting'])('skips unknown_user: %s', async (kind) => {
    if (kind === 'absent') state.records.delete('profiles/user');
    if (kind === 'anonymous') user().linkedAuthMethods = [];
    if (kind === 'deleting') user().deletionRequestedAt = 1;
    expect(await queueCrmMessage(input())).toEqual({ status: 'skipped', reason: 'unknown_user' });
  });
  it('skips no_device even with a reachable Telegram account', async () => {
    state.devices = false;
    user().notifications.telegram = { chatId: '123', status: 'reachable' };
    expect(await queueCrmMessage(input())).toEqual({ status: 'skipped', reason: 'no_device' });
  });
  it.each([false, undefined])(
    'requires explicit marketing tips=%s but transactional only needs the master',
    async (tips) => {
      user().notifications.groups.tips = tips;
      expect(await queueCrmMessage(input())).toEqual({ status: 'skipped', reason: 'opted_out' });
      expect(
        await queueCrmMessage({ ...input(), mid: 'transactional', category: 'transactional' }),
      ).toEqual({ status: 'queued', reason: null });
    },
  );
  it('initializes legacy missing settings before queueing a transactional job', async () => {
    delete user().notifications;
    expect(await queueCrmMessage({ ...input(), category: 'transactional' })).toEqual({
      status: 'queued',
      reason: null,
    });
    expect(user().notifications).toMatchObject({ enabled: true, groups: { tips: false } });
  });
  it('rejects transactional when the master is off', async () => {
    user().notifications.enabled = false;
    expect(await queueCrmMessage({ ...input(), category: 'transactional' })).toEqual({
      status: 'skipped',
      reason: 'opted_out',
    });
  });
  it('applies the existing daily cap and includes delivery reservations', async () => {
    Object.assign(user().notifications, {
      sentDay: '2026-11-16',
      sentCount: 5,
      reservedDay: '2026-11-16',
      reservedCount: 1,
    });
    expect(await queueCrmMessage(input())).toEqual({ status: 'skipped', reason: 'daily_cap' });
  });
  it('accepts only one marketing job per local delivery day under concurrent admission', async () => {
    const result = await Promise.all([
      queueCrmMessage(input()),
      queueCrmMessage({ ...input(), mid: 'second' }),
    ]);
    expect(result.map((r) => r.reason)).toEqual([null, 'daily_cap']);
    expect(
      await queueCrmMessage({ ...input(), mid: 'transactional', category: 'transactional' }),
    ).toMatchObject({ status: 'queued' });
  });
  it('stores the original outcome for repeated mids, including skipped messages and changed inputs', async () => {
    const result = await Promise.all([queueCrmMessage(input()), queueCrmMessage(input())]);
    expect(result).toEqual([
      { status: 'queued', reason: null },
      { status: 'queued', reason: null },
    ]);
    job().status = 'sent';
    state.devices = false;
    expect(await queueCrmMessage({ ...input(), uid: 'another' })).toEqual(result[0]);
    expect([...state.records.keys()].filter((k) => k.startsWith('notifications/'))).toHaveLength(1);
    const skipped = { ...input(), mid: 'skipped' };
    expect(await queueCrmMessage(skipped)).toMatchObject({ reason: 'no_device' });
    state.devices = true;
    expect(await queueCrmMessage(skipped)).toMatchObject({ reason: 'no_device' });
  });
  it('queues during quiet hours without extending TTL and caps marketing for tomorrow', async () => {
    vi.setSystemTime(Date.parse('2026-11-16T18:00:00Z'));
    expect(await queueCrmMessage(input())).toEqual({ status: 'queued', reason: null });
    expect(job()).toMatchObject({
      status: 'pending',
      pushOnly: true,
      type: 'crm',
      runAt: Date.parse('2026-11-17T03:00:00Z'),
      staleAt: Date.now() + 86400000,
    });
    expect(await queueCrmMessage({ ...input(), mid: 'second' })).toMatchObject({
      reason: 'daily_cap',
    });
  });
  it('stores expired outcome when quiet hours consume the TTL', async () => {
    vi.setSystemTime(Date.parse('2026-11-16T18:00:00Z'));
    expect(await queueCrmMessage({ ...input(), ttlSec: 60 })).toEqual({
      status: 'skipped',
      reason: 'expired',
    });
  });
  it('maps durable status and unknown mids using one batch', async () => {
    state.statusRows = [
      {
        id: Buffer.from(crmMessageKey('sent')),
        data_json: { status: 'sent', sentAt: 10 },
        types_json: {},
      },
    ];
    expect(await crmMessageStatuses(['sent', 'missing'])).toEqual({
      messages: [
        { mid: 'sent', status: 'sent', reason: null, at: 10 },
        { mid: 'missing', status: 'unknown', reason: null, at: null },
      ],
    });
    expect(crmStatus('m', { status: 'pending', updatedAt: 1 }).status).toBe('queued');
    expect(crmStatus('m', { status: 'sending', updatedAt: 1 }).status).toBe('queued');
    expect(
      crmStatus('m', { status: 'cancelled', skipReason: 'disabled', updatedAt: 1 }),
    ).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(
      crmStatus('m', { status: 'failed', lastError: 'private provider text', updatedAt: 1 }),
    ).toMatchObject({ status: 'failed', reason: 'delivery_failed' });
  });
  it('validates every bounded request shape', () => {
    for (const patch of [
      { title: 'a'.repeat(51) },
      { body: 'a'.repeat(151) },
      { link: 'https://example.com' },
      { link: '/' + 'a'.repeat(200) },
      { ttlSec: 59 },
      { ttlSec: 604801 },
      { collapseKey: '😀'.repeat(17) },
      { uid: 'a/b' },
      { channel: 'telegram' },
    ])
      expect(crmMessageBody.safeParse({ ...input(), ...patch }).success).toBe(false);
    expect(crmFactsBody.safeParse({ uids: [] }).success).toBe(false);
    expect(crmFactsBody.safeParse({ uids: Array(201).fill('u') }).success).toBe(false);
    expect(crmStatusBody.safeParse({ mids: Array(501).fill('m') }).success).toBe(false);
    expect(crmUsersQuery.parse({}).limit).toBe(500);
    expect(crmUsersQuery.safeParse({ limit: 501 }).success).toBe(false);
  });
});
