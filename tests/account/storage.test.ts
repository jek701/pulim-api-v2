import { Kysely, MysqlDialect } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock('../../src/db/database', () => ({ database: () => state.db }));
import { deleteByOwner, deleteByField, markDeletion, clearDeletion, listPendingAccountDeletions } from '../../src/db/accountDeletion';

describe('account deletion SQL', () => {
  const db = new Kysely<any>({ dialect: new MysqlDialect({ pool: {} as any }) });
  const execute = vi.spyOn(db.getExecutor(), 'executeQuery');
  beforeEach(() => {
    state.db = db;
    execute.mockReset();
  });

  it('deletes bounded batches directly without inserts, sync or notification writes', async () => {
    execute
      .mockResolvedValueOnce({ rows: [], numAffectedRows: 1000n })
      .mockResolvedValueOnce({ rows: [], numAffectedRows: 1000n })
      .mockResolvedValueOnce({ rows: [], numAffectedRows: 12n });
    expect(await deleteByOwner('transactions', 'synthetic-uid')).toBe(2012);
    expect(execute).toHaveBeenCalledTimes(3);
    for (const [query] of execute.mock.calls) {
      expect(query.sql).toMatch(/^DELETE FROM `transactions` WHERE user_id = \? LIMIT \?$/);
      expect(query.parameters).toEqual([Buffer.from('synthetic-uid'), 1000]);
      expect(query.sql).not.toMatch(/notifications|sync_entries|INSERT|UPDATE/);
    }
  });

  it('matches uid-keyed records by binary id and returns zero for already gone data', async () => {
    execute.mockResolvedValue({ rows: [], numAffectedRows: 0n });
    expect(await deleteByField('userSettings', '__id__', 'synthetic-uid')).toBe(0);
    expect(execute.mock.calls[0][0].sql).toContain('WHERE id = ? LIMIT ?');
  });
  it('narrows indexed fields before applying the JSON ownership check', async () => {
    execute.mockResolvedValue({ rows: [], numAffectedRows: 0n });
    await deleteByField('budgets', 'householdId', 'family');
    expect(execute.mock.calls[0][0].sql).toContain('WHERE `household_id` = ? AND JSON_EXTRACT');
    expect(execute.mock.calls[0][0].parameters).toEqual([
      Buffer.from('family'),
      '$.householdId',
      '"family"',
      1000,
    ]);
  });
  it('selects unindexed matches without locks, then deletes only their primary keys', async () => {
    execute
      .mockResolvedValueOnce({ rows: [{ id: Buffer.from('match') }] })
      .mockResolvedValueOnce({ rows: [], numAffectedRows: 1n })
      .mockResolvedValueOnce({ rows: [] });
    expect(await deleteByField('telegramUsers', 'profileUid', 'user')).toBe(1);
    expect(execute.mock.calls[0][0].sql).toMatch(/^SELECT `id`/);
    expect(execute.mock.calls[0][0].sql).not.toContain('FOR UPDATE');
    expect(execute.mock.calls[1][0].sql).toContain(
      'DELETE FROM `telegram_users` WHERE `id` IN (?)',
    );
    expect(execute.mock.calls[1][0].sql).not.toContain('JSON_EXTRACT');
  });
  it('matches chatId strings through chat_lookup and legacy numbers through primary-key batches', async () => {
    execute
      .mockResolvedValueOnce({ rows: [], numAffectedRows: 1n })
      .mockResolvedValueOnce({ rows: [{ id: Buffer.from('number') }] })
      .mockResolvedValueOnce({ rows: [], numAffectedRows: 1n })
      .mockResolvedValueOnce({ rows: [] });
    expect(await deleteByField('telegramMessages', 'chatId', '123')).toBe(2);
    expect(execute.mock.calls[0][0].sql).toContain('`chat_id` = ? AND JSON_EXTRACT');
    expect(execute.mock.calls[0][0].parameters).toContain('"123"');
    expect(execute.mock.calls[1][0].sql).toContain("'UNSIGNED INTEGER'");
    expect(execute.mock.calls[1][0].parameters).toContain('123');
    expect(execute.mock.calls[2][0].sql).toContain('`id` IN (?)');
  });
  it('preserves the original deletion timestamp on repeated requests with UPDATE/COALESCE', async () => {
    execute.mockResolvedValue({ rows: [], numAffectedRows: 1n });
    await markDeletion('synthetic-uid');
    await markDeletion('synthetic-uid');
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [query] of execute.mock.calls) {
      expect(query.sql).toContain('UPDATE profiles SET data_json = JSON_SET');
      expect(query.sql).toContain("COALESCE(JSON_EXTRACT(data_json, '$.deletionRequestedAt'), ?)");
      expect(query.sql).not.toMatch(/INSERT|DELETE/);
      expect(query.parameters[1]).toEqual(Buffer.from('synthetic-uid'));
    }
  });

  it('selects only numeric markers strictly older than the grace cutoff in bounded batches', async () => {
    execute.mockResolvedValue({ rows: [{ id: Buffer.from('old'), requestedAt: '100' }] });
    expect(await listPendingAccountDeletions(200, 20)).toEqual([{ uid: 'old', requestedAt: 100 }]);
    const query = execute.mock.calls[0][0];
    expect(query.sql).toContain("JSON_TYPE(JSON_EXTRACT(data_json, '$.deletionRequestedAt'))");
    expect(query.sql).toContain("'UNSIGNED INTEGER'");
    expect(query.sql).toContain("AND JSON_EXTRACT(data_json, '$.deletionRequestedAt') < ?");
    expect(query.sql).toContain('LIMIT ?');
    expect(query.parameters).toEqual([200, 20]);
  });

  it('restores with JSON_REMOVE only when the locked profile still exists', async () => {
    // Execute the transaction callback against the same mocked SQL executor.
    const transaction = vi.spyOn(db, 'transaction').mockReturnValue({ execute: (work: any) => work(db) } as any);
    try {
      execute.mockResolvedValueOnce({ rows: [{ id: Buffer.from('synthetic-uid') }] })
        .mockResolvedValueOnce({ rows: [], numAffectedRows: 1n });
      expect(await clearDeletion('synthetic-uid')).toBe(true);
      expect(execute.mock.calls[0][0].sql).toContain('FOR UPDATE');
      expect(execute.mock.calls[1][0].sql).toContain("JSON_REMOVE(data_json, '$.deletionRequestedAt')");
      execute.mockClear().mockResolvedValue({ rows: [] });
      expect(await clearDeletion('purged')).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      transaction.mockRestore();
    }
  });

});
