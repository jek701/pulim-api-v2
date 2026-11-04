import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), kick: vi.fn(), error: vi.fn() }));
vi.mock('../../src/push/outbox', () => ({ enqueueWriteEvents: mocks.enqueue }));
vi.mock('../../src/push/kick', () => ({ kickDelivery: mocks.kick }));
vi.mock('../../src/utils/logger', () => ({ logger: { error: mocks.error } }));
import { documentKey, insertDocumentIfAbsent, queryTable, SqlTransaction } from '../../src/db/documents';
import { setPushWriteEventsEnabled } from '../../src/db/pushWriteConfig';

function executor() {
  const query: any = {
    selectAll: vi.fn(() => query), where: vi.fn(() => query), forUpdate: vi.fn(() => query),
    executeTakeFirst: vi.fn(async () => undefined),
    values: vi.fn(() => query), onDuplicateKeyUpdate: vi.fn(() => query), execute: vi.fn(async () => []),
  };
  const db = { selectFrom: vi.fn(() => query), insertInto: vi.fn(() => query) };
  return { query, db: db as unknown as Kysely<any> };
}
beforeEach(() => {
  vi.clearAllMocks();
  setPushWriteEventsEnabled(true);
  mocks.enqueue.mockResolvedValue(true);
});
describe('optional push hooks in user write transactions', () => {
  it('swallows a non-lock outbox error and completes the effect', async () => {
    const { db, query } = executor();
    mocks.enqueue.mockRejectedValueOnce(new Error('push defect'));
    const tx = new SqlTransaction(db);
    tx.insert(documentKey(queryTable('savingsGoals'), 'goal'), { userId: 'u', savedAmount: 100 });
    await expect(tx.flush(db)).resolves.toBeUndefined();
    expect(query.execute).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith({ code: undefined }, 'notify.push.outbox_failed');
    tx.notifyCommitted();
    expect(mocks.kick).not.toHaveBeenCalled();
  });
  it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])('propagates %s for transaction retry', async code => {
    const { db } = executor();
    const error = Object.assign(new Error('lock'), { code });
    mocks.enqueue.mockRejectedValueOnce(error);
    const tx = new SqlTransaction(db);
    tx.insert(documentKey(queryTable('savingsGoals'), 'goal'), { userId: 'u' });
    await expect(tx.flush(db)).rejects.toBe(error);
    expect(mocks.error).not.toHaveBeenCalled();
  });
  it('dispatches only after commit, and disabled storage hooks never load outbox', async () => {
    const { db } = executor();
    const tx = new SqlTransaction(db);
    tx.insert(documentKey(queryTable('savingsGoals'), 'goal'), { userId: 'u' });
    await tx.flush(db);
    expect(mocks.kick).not.toHaveBeenCalled();
    tx.notifyCommitted();
    expect(mocks.kick).toHaveBeenCalledOnce();
    setPushWriteEventsEnabled(false);
    const disabled = new SqlTransaction(db);
    disabled.insert(documentKey(queryTable('savingsGoals'), 'other'), { userId: 'u' });
    await disabled.flush(db);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
  it('inserts an optional outbox row with no locking pre-read and a no-op duplicate update', async () => {
    const { db, query } = executor();
    await insertDocumentIfAbsent(db, documentKey(queryTable('notifications'), 'n'), { status: 'pending' });
    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.insertInto).toHaveBeenCalledWith('notifications');
    expect(query.onDuplicateKeyUpdate).toHaveBeenCalledWith({ id: expect.anything() });
    expect(query.execute).toHaveBeenCalledOnce();
  });
});
