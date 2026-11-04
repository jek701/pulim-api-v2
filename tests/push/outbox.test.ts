import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { WriteChange } from '../../src/push/events';

const mocks = vi.hoisted(() => ({
  env: { NOTIFICATIONS_ENABLED: true, PUSH_ENABLED: true, NOTIFY_BUDGET_DEBOUNCE_MS: 25_000 },
  allowed: new Set(['owner', 'partner']),
  documents: new Map<string, Record<string, any>>(),
  constructors: vi.fn(), reads: vi.fn(), inserts: vi.fn(), saves: vi.fn(), flush: vi.fn(),
  createNotification: vi.fn(), sendApns: vi.fn(), sendTelegram: vi.fn(), kick: vi.fn(), armBudgetCheck: vi.fn(),
  operations: [] as string[],
}));

vi.mock('../../src/config/env', () => ({ env: mocks.env, notificationRecipientAllowed: (uid: string) => mocks.allowed.has(uid) }));
vi.mock('../../src/db/documents', () => ({
  documentKey: (table: { table: string }, id: string) => ({ table: table.table, id }),
  queryTable: (table: string) => ({ table }),
  Timestamp: { fromMillis: (value: number) => value },
  SqlTransaction: class {
    constructor(executor: unknown) { mocks.constructors(executor); }
    async read(ref: { table: string; id: string }) {
      mocks.operations.push('read');
      mocks.reads(ref);
      const data = mocks.documents.get(`${ref.table}/${ref.id}`);
      return { exists: Boolean(data), data, id: ref.id, key: ref };
    }
    insert(ref: { table: string; id: string }, data: Record<string, any>) {
      mocks.operations.push('insert'); mocks.inserts(ref, data);
    }
    save(ref: { table: string; id: string }, data: Record<string, any>, options?: unknown) {
      mocks.operations.push('save'); mocks.saves(ref, data, options);
    }
    async flush(executor: unknown) { mocks.operations.push('flush'); await mocks.flush(executor); }
  },
}));
vi.mock('../../src/notifications/queue.repository', () => ({
  notificationId: (key: string) => `hashed:${key}`,
  queuedNotificationData: (input: unknown, now: number) => ({ ...(input as object), createdAt: now, status: 'pending' }),
  createNotification: mocks.createNotification,
  armBudgetCheck: mocks.armBudgetCheck,
}));
vi.mock('../../src/push/apns', () => ({ sendApns: mocks.sendApns }));
vi.mock('../../src/telegram/client', () => ({ sendMessage: mocks.sendTelegram }));
vi.mock('../../src/push/kick', () => ({ kickDelivery: mocks.kick }));

import { enqueueWriteEvents } from '../../src/push/outbox';

const now = Date.parse('2026-11-04T05:00:00Z');
const executor = { marker: 'the caller transaction connection' } as unknown as Kysely<any>;
const goal = (id = 'goal'): WriteChange => ({ key: { table: 'savingsGoals', id }, before: { savedAmount: 90 },
  after: { userId: 'owner', targetAmount: 100, savedAmount: 100, name: 'Trip', currency: 'UZS' } });
const expense = (): WriteChange => ({ key: { table: 'transactions', id: 'tx' }, after: {
  userId: 'partner', householdId: 'family', scope: 'household', type: 'expense', amount: 10,
  createdBy: 'partner', createdByName: 'Ali', currency: 'UZS', categoryName: 'Food',
} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  mocks.documents.clear(); mocks.operations.length = 0;
  mocks.allowed = new Set(['owner', 'partner']);
  mocks.env.NOTIFICATIONS_ENABLED = true; mocks.env.PUSH_ENABLED = true;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('transactional push outbox', () => {
  it('queues on the caller executor without dispatching or using a separate queue write', async () => {
    expect(await enqueueWriteEvents(executor, [goal()])).toBe(true);
    expect(mocks.constructors).toHaveBeenCalledExactlyOnceWith(executor);
    expect(mocks.flush).toHaveBeenCalledExactlyOnceWith(executor);
    expect(mocks.inserts).toHaveBeenCalledWith({ table: 'notifications', id: 'hashed:goal_reached:goal:owner' },
      expect.objectContaining({ userId: 'owner', dedupeKey: 'goal_reached:goal:owner', runAt: now, createdAt: now,
        payload: expect.objectContaining({ type: 'goal_reached', eventAt: now }) }));
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.sendApns).not.toHaveBeenCalled();
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it('skips an existing notification without another insert or flush', async () => {
    mocks.documents.set('notifications/hashed:goal_reached:goal:owner', { status: 'sent' });
    expect(await enqueueWriteEvents(executor, [goal()])).toBe(false);
    expect(mocks.inserts).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it('buffers each durable notification once when changes derive the same event repeatedly', async () => {
    await enqueueWriteEvents(executor, [goal(), goal()]);
    expect(mocks.inserts).toHaveBeenCalledTimes(1);
    expect(mocks.flush).toHaveBeenCalledExactlyOnceWith(executor);
  });

  it('enforces the rollout allowlist before reading or writing notification rows', async () => {
    mocks.allowed.clear();
    expect(await enqueueWriteEvents(executor, [goal()])).toBe(false);
    expect(mocks.reads).not.toHaveBeenCalled();
    expect(mocks.inserts).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it('resolves household recipients in the same transaction, excludes the actor and applies the allowlist', async () => {
    mocks.documents.set('households/family', { memberIds: ['owner', 'partner', 'outsider'] });
    expect(await enqueueWriteEvents(executor, [expense()])).toBe(true);
    expect(mocks.reads).toHaveBeenCalledWith({ table: 'households', id: 'family' });
    const recipients = mocks.inserts.mock.calls.filter(([ref]) => ref.table === 'notifications').map(([, data]) => data.userId);
    expect(recipients).toEqual(['owner']);
    expect(mocks.reads).not.toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringContaining(':partner') }));
    expect(mocks.reads).not.toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringContaining(':outsider') }));
  });

  it('reads all recipients and dedupe records before buffering writes', async () => {
    mocks.documents.set('households/family', { memberIds: ['owner', 'partner'] });
    const householdGoal = goal('shared'); householdGoal.after.householdId = 'family';
    expect(await enqueueWriteEvents(executor, [householdGoal, goal('personal')])).toBe(true);
    const firstWrite = mocks.operations.findIndex(operation => operation === 'insert' || operation === 'save');
    expect(firstWrite).toBeGreaterThan(0);
    expect(mocks.operations.slice(firstWrite)).not.toContain('read');
    expect(mocks.flush).toHaveBeenCalledExactlyOnceWith(executor);
  });

  it('propagates queue write failure so the caller can roll back its business write', async () => {
    const error = new Error('transaction insert failed');
    mocks.flush.mockRejectedValueOnce(error);
    await expect(enqueueWriteEvents(executor, [goal()])).rejects.toBe(error);
    expect(mocks.sendApns).not.toHaveBeenCalled();
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it.each(['NOTIFICATIONS_ENABLED', 'PUSH_ENABLED'] as const)('does no queue work when %s is off', async flag => {
    mocks.env[flag] = false;
    expect(await enqueueWriteEvents(executor, [goal()])).toBe(false);
    expect(mocks.constructors).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it('does not start an outbox transaction for a write with no immediate event', async () => {
    expect(await enqueueWriteEvents(executor, [{ key: { table: 'cards', id: 'c' }, after: { balance: 10 } }])).toBe(false);
    expect(mocks.constructors).not.toHaveBeenCalled();
  });

  it('durably debounces each touched category for 25 seconds and arms timers only through afterCommit callbacks', async () => {
    const callbacks: Array<() => void> = [];
    const tx: WriteChange = { key: { table: 'transactions', id: 'personal' }, after: {
      userId: 'owner', categoryId: 'food', type: 'expense', amount: 10,
    } };
    await enqueueWriteEvents(executor, [tx, tx], callback => callbacks.push(callback));
    expect(mocks.saves).toHaveBeenCalledExactlyOnceWith({ table: 'notificationTasks', id: 'hashed:budget_check:owner:food' },
      expect.objectContaining({ userId: 'owner', categoryId: 'food', type: 'budget_check', status: 'pending',
        version: 1, runAt: now + 25_000, eventAt: now, createdAt: now, updatedAt: now, rerunAt: null, leaseUntil: null }),
      { merge: true });
    expect(mocks.flush).toHaveBeenCalledExactlyOnceWith(executor);
    expect(mocks.armBudgetCheck).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    expect(mocks.armBudgetCheck).toHaveBeenCalledExactlyOnceWith('owner:food');
    expect(mocks.sendApns).not.toHaveBeenCalled();
  });

  it('reschedules both old and new categories after an edit with one durable task for each', async () => {
    const tx: WriteChange = { key: { table: 'transactions', id: 'personal' }, before: {
      userId: 'owner', categoryId: 'food', type: 'expense', amount: 10,
    }, after: { userId: 'owner', categoryId: 'transport', type: 'expense', amount: 20 } };
    await enqueueWriteEvents(executor, [tx]);
    expect(mocks.saves.mock.calls.map(([ref]) => ref.id).sort())
      .toEqual(['hashed:budget_check:owner:food', 'hashed:budget_check:owner:transport']);
    expect(mocks.saves.mock.calls.every(([, data]) => data.runAt === now + 25_000)).toBe(true);
  });

  it('preserves an active processing lease while increasing task version and scheduling a rerun', async () => {
    mocks.documents.set('notificationTasks/hashed:budget_check:owner:food', {
      status: 'processing', version: 4, claimedVersion: 4, runAt: now - 1000,
      leaseUntil: now + 60_000, createdAt: now - 86_400_000,
    });
    await enqueueWriteEvents(executor, [{ key: { table: 'transactions', id: 'tx' }, after: { userId: 'owner', categoryId: 'food' } }]);
    const data = mocks.saves.mock.calls[0]![1];
    expect(data).toMatchObject({ version: 5, rerunAt: now + 25_000, eventAt: now, createdAt: now - 86_400_000 });
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('runAt');
    expect(data).not.toHaveProperty('leaseUntil');
    expect(data).not.toHaveProperty('claimedVersion');
  });

  it('replaces expired processing leases with a fresh pending debounce', async () => {
    mocks.documents.set('notificationTasks/hashed:budget_check:owner:food', { status: 'processing', version: 7, leaseUntil: now - 1 });
    await enqueueWriteEvents(executor, [{ key: { table: 'transactions', id: 'tx' }, after: { userId: 'owner', categoryId: 'food' } }]);
    expect(mocks.saves.mock.calls[0]![1]).toMatchObject({ status: 'pending', version: 8, leaseUntil: null, runAt: now + 25_000, rerunAt: null });
  });

  it('does not arm wakeup callbacks if durable flushing fails', async () => {
    const afterCommit = vi.fn();
    mocks.flush.mockRejectedValueOnce(new Error('rollback'));
    await expect(enqueueWriteEvents(executor, [{ key: { table: 'transactions', id: 'tx' },
      after: { userId: 'owner', categoryId: 'food' } }], afterCommit)).rejects.toThrow('rollback');
    expect(afterCommit).not.toHaveBeenCalled();
    expect(mocks.armBudgetCheck).not.toHaveBeenCalled();
  });

  it('does not plan personal budget tasks for household expenses, transfers or unapproved users', async () => {
    await enqueueWriteEvents(executor, [expense(),
      { key: { table: 'transactions', id: 'transfer' }, after: { userId: 'owner', categoryId: 'food', source: 'transfer' } },
      { key: { table: 'transactions', id: 'other' }, after: { userId: 'outsider', categoryId: 'food' } },
    ]);
    expect(mocks.saves).not.toHaveBeenCalled();
  });
});
