import { Kysely, MysqlDialect } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: undefined as any, sync: vi.fn(), read: vi.fn() }));
vi.mock('../../src/db/database', () => ({ database: () => state.db }));
vi.mock('../../src/db/documents', async (actual) => ({
  ...(await actual<typeof import('../../src/db/documents')>()),
  readDocument: state.read,
}));
vi.mock('../../src/db/syncIndex', async (actual) => ({
  ...(await actual<typeof import('../../src/db/syncIndex')>()),
  recordSyncChanges: state.sync,
}));
import {
  cleanHouseholdReferences,
  purgeRelated,
  scrubArchivedReferences,
} from '../../src/db/accountDeletion';
import { encodeData, decodeData } from '../../src/db/values';

describe('shared references and indirect deletion', () => {
  const db = new Kysely<any>({ dialect: new MysqlDialect({ pool: {} as any }) });
  const execute = vi.spyOn(db.getExecutor(), 'executeQuery');
  beforeEach(() => {
    vi.clearAllMocks();
    state.db = {
      getExecutor: () => db.getExecutor(),
      transaction: () => ({ execute: (fn: any) => fn(db) }),
    };
    state.read.mockResolvedValue({ exists: true, data: { name: 'Deleted name' }, rows: [] });
    execute.mockResolvedValue({ rows: [], numAffectedRows: 0n });
  });
  for (const dissolving of [true, false]) {
    it(`clears uid/name pairs on all four shared entities and syncs personal survivors (owner=${dissolving})`, async () => {
      const before = {
        userId: 'partner',
        householdId: 'family',
        scope: 'household',
        balance: 42,
        createdBy: 'deleted',
        createdByName: 'Deleted name',
        accountOwnerId: 'deleted',
        accountOwnerName: 'Deleted name',
        familyAccess: { householdId: 'family', enabled: true },
      };
      execute.mockImplementation(async (query) => {
        if (
          query.sql.startsWith('SELECT id FROM') &&
          (query.parameters.at(-2) as Buffer).length === 0
        )
          return { rows: [{ id: Buffer.from('survivor') }] };
        if (query.sql.startsWith('SELECT id, data_json'))
          return { rows: [{ id: Buffer.from('survivor'), ...encodeData(before) }] };
        return { rows: [], numAffectedRows: 1n };
      });
      await cleanHouseholdReferences('deleted', 'family', dissolving);
      const updates = execute.mock.calls
        .map(([query]) => query)
        .filter((query) => query.sql.startsWith('update'));
      expect(updates).toHaveLength(4);
      for (const update of updates) {
        const after = decodeData(update.parameters[0], update.parameters[1]);
        expect(Object.values(after)).not.toContain('deleted');
        expect(Object.values(after)).not.toContain('Deleted name');
        expect(after.balance).toBe(42);
        expect(after.scope).toBe('household');
        expect(after.householdId).toBe(dissolving ? undefined : 'family');
      }
      for (const entity of ['cards', 'transactions', 'savingsGoals', 'budgets'])
        expect(state.sync).toHaveBeenCalledWith(db, [
          { scope: 'u:partner', entity, id: 'survivor', deleted: false },
        ]);
      expect(execute.mock.calls.map(([q]) => q.sql).join('\n')).not.toMatch(
        /notification|push_devices/,
      );
    });
  }
  it('keeps another household archive and its other members while removing exact uid/name references', () => {
    const archive = {
      path: 'households/other',
      fields: {
        ownerUserId: { type: 'string', value: 'other' },
        memberIds: {
          type: 'array',
          values: [
            { type: 'string', value: 'other' },
            { type: 'string', value: 'deleted' },
          ],
        },
        members: {
          type: 'array',
          values: [
            {
              type: 'map',
              fields: {
                userId: { type: 'string', value: 'deleted' },
                name: { type: 'string', value: 'Deleted name' },
              },
            },
          ],
        },
        createdBy: { type: 'string', value: 'deleted' },
        createdByName: { type: 'string', value: 'Deleted name' },
      },
    };
    const result = scrubArchivedReferences(archive, 'deleted', 'Deleted name');
    expect(result.path).toBe('households/other');
    expect(result.fields.ownerUserId.value).toBe('other');
    expect(result.fields.memberIds.values).toEqual([{ type: 'string', value: 'other' }]);
    expect(JSON.stringify(result)).not.toMatch(/deleted|Deleted name/);
  });
  it('purges capture links before transaction removal and preserves shared campaigns', async () => {
    const seen = new Set<string>();
    execute.mockImplementation(async (query) => {
      for (const [table, key] of [
        ['capture_learning', 'transaction_hash'],
        ['capture_receipt_cache', 'receipt_key'],
      ]) {
        if (query.sql.startsWith(`SELECT \`${key}\``) && !seen.has(table)) {
          seen.add(table);
          return { rows: [{ [key]: 'hash' }] };
        }
      }
      if (query.sql.startsWith('SELECT id FROM communication_campaigns') && !seen.has('campaign')) {
        seen.add('campaign');
        return { rows: [{ id: Buffer.from('campaign') }] };
      }
      return { rows: [], numAffectedRows: 1n };
    });
    await purgeRelated('deleted');
    const queries = execute.mock.calls.map(([q]) => q);
    expect(queries.some((q) => q.sql.includes('DELETE FROM `capture_learning`'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('DELETE FROM `capture_receipt_cache`'))).toBe(true);
    expect(queries.map((q) => q.sql).join('\n')).not.toMatch(
      /DELETE FROM [`]?transactions|DELETE FROM [`]?communication_campaigns/,
    );
    const archiveDeletes = queries.filter((q) => q.sql.startsWith('SELECT `path_hash`'));
    expect(archiveDeletes).toHaveLength(2);
    expect(archiveDeletes.map((q) => q.sql).join('\n')).not.toContain('memberIds');
    const campaign = queries.find((q) => q.sql.startsWith('UPDATE communication_campaigns'))!;
    expect(campaign.sql).toContain("'$.createdBy', '$.createdByName'");
    expect(campaign.sql).toContain('WHERE id IN (?)');
    expect(campaign.parameters).toContainEqual(Buffer.from('campaign'));
  });
});
