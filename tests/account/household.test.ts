import { Kysely, MysqlDialect } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  db: undefined as any,
  household: {} as any,
  purge: vi.fn(),
  field: vi.fn(),
  clean: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({ env: {} }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/db/database', () => ({ database: () => state.db }));
vi.mock('../../src/db/accountDeletion', () => ({
  deleteBatches: state.purge,
  deleteByField: state.field,
  cleanHouseholdReferences: state.clean,
}));
vi.mock('../../src/db/documents', async (importActual) => ({
  ...(await importActual<typeof import('../../src/db/documents')>()),
  readDocument: async () => ({ rows: [{ id: 'household-test', data: state.household }] }),
}));
import { removeAccountFromHouseholds } from '../../src/services/household.service';

describe('household account deletion', () => {
  const db = new Kysely<any>({ dialect: new MysqlDialect({ pool: {} as any }) });
  const execute = vi.spyOn(db.getExecutor(), 'executeQuery');
  beforeEach(() => {
    execute.mockReset().mockResolvedValue({ rows: [], numAffectedRows: 1n });
    state.purge.mockReset().mockResolvedValue(1);
    state.clean.mockReset().mockResolvedValue(undefined);
    state.field.mockReset().mockResolvedValue(1);
    state.db = {
      getExecutor: () => db.getExecutor(),
      transaction: () => ({ execute: (fn: any) => fn(db) }),
    };
    state.household = {
      ownerUserId: 'owner',
      memberIds: ['owner', 'partner'],
      members: [{ userId: 'owner' }, { userId: 'partner' }],
    };
  });
  it('dissolves an owner household, retains personal-card operations and never changes balances', async () => {
    expect(await removeAccountFromHouseholds('owner')).toMatchObject({ households: 1 });
    expect(state.field).toHaveBeenCalledWith('householdInvites', 'householdId', 'household-test');
    const sql = execute.mock.calls.map(([query]) => query.sql).join('\n');
    expect(sql).toContain('DELETE FROM households');
    expect(sql).toContain('DELETE FROM household_members');
    expect(sql).not.toMatch(/balance|UPDATE profiles|DELETE FROM profiles/);
    // Preserve historical household scope: changing it would change the other member's analytics.
    expect(sql).not.toContain("'$.scope'");
    expect(state.clean).toHaveBeenCalledWith('owner', 'household-test', true);
    expect(state.purge).toHaveBeenCalledTimes(2); // only shared cards and shared transactions
    const deletes = state.purge.mock.calls.map(([, predicate]) => predicate.compile(db));
    expect(
      deletes.every((query) =>
        query.parameters.some(
          (value) => Buffer.isBuffer(value) && value.toString() === 'household:household-test',
        ),
      ),
    ).toBe(true);
  });
  it('removes the non-owner from membership while keeping shared objects and the owner account', async () => {
    await removeAccountFromHouseholds('partner');
    expect(state.clean).toHaveBeenCalledWith('partner', 'household-test', false);
    expect(state.purge).not.toHaveBeenCalled();
    expect(state.field).not.toHaveBeenCalled();
    const membership = execute.mock.calls
      .map(([query]) => query)
      .find((query) => query.sql.startsWith('UPDATE households'))!;
    expect(membership.parameters).toContain(JSON.stringify([{ userId: 'owner' }]));
    expect(membership.parameters).toContain(JSON.stringify(['owner']));
    expect(execute.mock.calls.every(([query]) => !query.sql.includes('profiles'))).toBe(true);
  });
});
