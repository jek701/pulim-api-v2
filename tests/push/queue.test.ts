import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ records: new Map<string, any>(), tail: Promise.resolve() }));
vi.mock('../../src/config/env', () => ({
  env: {
    NOTIFY_TIMEZONE: 'Asia/Tashkent',
    NOTIFY_SAFETY_MAX_PER_USER_PER_DAY: 6,
    NOTIFY_LEASE_MS: 120000,
  },
  notificationAllowedUids: new Set(),
  notificationRecipientAllowed: () => true,
}));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }),
  documentKey: (query: { table: string }, id: string) => ({ table: query.table, id }),
  Timestamp: { fromMillis: (n: number) => n },
  patchValue: { arrayUnion: (v: unknown) => ({ union: v }) },
  runSqlTransaction: (work: (tx: any) => Promise<unknown>) => {
    const next = store.tail.then(async () => {
      const writes: Array<() => void> = [];
      const apply = (key: any, patch: any, merge = true) =>
        writes.push(() => {
          const previous = store.records.get(`${key.table}/${key.id}`) ?? {};
          const row = merge ? structuredClone(previous) : {};
          for (const [path, value] of Object.entries(patch)) {
            const parts = path.split('.');
            let target = row;
            for (const part of parts.slice(0, -1)) target = target[part] ??= {};
            const field = parts.at(-1)!;
            target[field] =
              value && typeof value === 'object' && 'union' in value
                ? [...new Set([...(target[field] ?? []), value.union])]
                : value;
          }
          store.records.set(`${key.table}/${key.id}`, row);
        });
      const result = await work({
        read: async (key: any) => {
          if (writes.length) throw new Error('Read after write');
          const data = store.records.get(`${key.table}/${key.id}`);
          return { id: key.id, exists: Boolean(data), data: structuredClone(data) };
        },
        insert: (key: any, data: any) => apply(key, data, false),
        patch: (key: any, patch: any) => apply(key, patch),
        save: (key: any, patch: any, options?: any) => apply(key, patch, options?.merge === true),
      });
      writes.forEach((commit) => commit());
      return result;
    });
    store.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  },
}));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import {
  claimNotification,
  markNotificationSent,
  recordChannelDelivery,
  reserveSafetySlot,
  upsertScheduledNotification,
} from '../../src/notifications/queue.repository';
import type { QueuedNotification } from '../../src/notifications/types';
const now = Date.parse('2026-11-04T07:00:00Z');
const user = () => store.records.get('profiles/u');
const job = () => store.records.get('notifications/n');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  store.records.clear();
  store.tail = Promise.resolve();
  store.records.set('profiles/u', {
    notifications: {
      enabled: true,
      timezone: 'Asia/Tashkent',
      telegram: { status: 'blocked', chatId: null },
      sentDay: '',
      sentCount: 0,
      reservedDay: '',
      reservedCount: 0,
    },
  });
  store.records.set('notifications/n', {
    userId: 'u',
    status: 'pending',
    nextAttemptAt: now,
    attempts: 0,
    payload: { kind: 'push', group: 'money' },
    stateKeys: [],
    stateEffects: {},
  });
});
afterEach(() => vi.useRealTimers());
describe('shared SQL claim and per-user safety accounting', () => {
  it('allows exactly one of two concurrent process claims', async () => {
    const claims = await Promise.all([claimNotification('n', now), claimNotification('n', now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(job().attempts).toBe(1);
  });
  it('reserves push slots even when Telegram is blocked, and stops after six', async () => {
    const results = await Promise.all(Array.from({ length: 7 }, () => reserveSafetySlot('u', now)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(6);
    expect(results.at(-1)).toBe('cap');
  });
  it('counts the first accepted device even if a sibling fails, and never counts its retry twice', async () => {
    const notification = (await claimNotification('n', now)) as QueuedNotification;
    await reserveSafetySlot('u', now);
    await recordChannelDelivery(notification, 'device1');
    expect(user().notifications).toMatchObject({ sentCount: 1, reservedCount: 0 });
    await recordChannelDelivery(notification, 'device2');
    await markNotificationSent(notification, null, false, now);
    expect(user().notifications.sentCount).toBe(1);
    expect(job().deliveredDevices).toEqual(['device1', 'device2']);
    expect(user().notifications.telegram.status).toBe('blocked');
  });
  it('reserves only one habit message per local day and resets at local midnight', async () => {
    expect(await reserveSafetySlot('u', now, false, true)).toBe('ok');
    expect(await reserveSafetySlot('u', now, false, true)).toBe('cap');
    expect(await reserveSafetySlot('u', now + 86400000, false, true)).toBe('ok');
  });
});

describe('scheduled occurrence timezone changes', () => {
  it('moves a pending occurrence and never reopens a delivered one', async () => {
    const input = {
      userId: 'u',
      chatId: '',
      type: 'subscription_due' as const,
      runAt: now,
      payload: {
        kind: 'push' as const,
        type: 'subscription_due' as const,
        group: 'money' as const,
        link: '/subscriptions/s',
        values: {},
        eventAt: now,
      },
      dedupeKey: 'slot',
    };
    expect(await upsertScheduledNotification(input)).toBe(true);
    const key = [...store.records.keys()].find(
      (key) => key.startsWith('notifications/') && key !== 'notifications/n',
    )!;
    await upsertScheduledNotification({ ...input, runAt: now + 3600000 });
    expect(store.records.get(key).runAt).toBe(now + 3600000);
    store.records.get(key).status = 'sent';
    await upsertScheduledNotification({ ...input, runAt: now + 7200000 });
    expect(store.records.get(key).status).toBe('sent');
    expect(store.records.get(key).runAt).toBe(now + 3600000);
  });
});
