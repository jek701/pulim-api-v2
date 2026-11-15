import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tables } from '../../src/db/tables';

const mocks = vi.hoisted(() => ({
  markDeletion: vi.fn(),
  deleteByOwner: vi.fn(),
  deleteByField: vi.fn(),
  purgeRelated: vi.fn(),
  purgeRelational: vi.fn(),
  household: vi.fn(),
  deleteUser: vi.fn(),
  revokeRefreshTokens: vi.fn(),
  getUser: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../src/db/accountDeletion', () => mocks);
vi.mock('../../src/config/firebaseAuth', () => ({ auth: mocks }));
vi.mock('../../src/services/household.service', () => ({
  removeAccountFromHouseholds: mocks.household,
}));
vi.mock('../../src/utils/logger', () => ({ logger: { info: mocks.info } }));
import { accountDeletionPolicy, deleteAccount } from '../../src/services/accountDeletion.service';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deleteByOwner.mockResolvedValue(2);
  mocks.deleteByField.mockResolvedValue(1);
  mocks.purgeRelated.mockResolvedValue({});
  mocks.purgeRelational.mockResolvedValue({});
  mocks.household.mockResolvedValue({});
  mocks.getUser.mockResolvedValue({});
});

describe('resumable account deletion', () => {
  it('classifies every table and deletes every classified owned document below the write hooks', async () => {
    expect(Object.keys(accountDeletionPolicy).sort()).toEqual(Object.keys(tables).sort());
    await deleteAccount('test-user');
    for (const [entity, policy] of Object.entries(accountDeletionPolicy)) {
      if (
        ['keep', 'keep-dedupe', 'keep-author-anonymised', 'household', 'profile-last'].includes(
          policy,
        )
      )
        continue;
      expect(mocks.deleteByOwner.mock.calls.filter(([name]) => name === entity)).toHaveLength(2);
    }
    expect(mocks.deleteByOwner).not.toHaveBeenCalledWith('communicationCampaigns', 'test-user');
    expect(mocks.purgeRelated).toHaveBeenCalledTimes(2);
    const txSweeps = mocks.deleteByOwner.mock.calls.flatMap(([entity], index) =>
      entity === 'transactions' ? [mocks.deleteByOwner.mock.invocationCallOrder[index]] : [],
    );
    for (let pass = 0; pass < 2; pass++)
      expect(mocks.purgeRelated.mock.invocationCallOrder[pass]).toBeLessThan(txSweeps[pass]);
    expect(mocks.deleteByField).toHaveBeenCalledWith('telegramUsers', 'profileUid', 'test-user');
    expect(mocks.deleteByField).toHaveBeenCalledWith(
      'phoneVerifications',
      'targetUid',
      'test-user',
    );
    expect(mocks.deleteByField).toHaveBeenCalledWith('userSettings', '__id__', 'test-user');
    expect(mocks.deleteByField).toHaveBeenLastCalledWith('profiles', '__id__', 'test-user');
    expect(mocks.markDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.purgeRelated.mock.invocationCallOrder[0],
    );
    expect(mocks.purgeRelational.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteByField.mock.invocationCallOrder.at(-1)!,
    );
    expect(mocks.deleteUser.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.deleteByField.mock.invocationCallOrder.at(-1)!,
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ uidHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      'account.deleted',
    );
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('test-user');
  });

  it('retries from the start after a failure in the middle without prematurely removing the profile/Auth', async () => {
    let failed = false;
    mocks.deleteByOwner.mockImplementation(async (table: string) => {
      if (table === 'transactions' && !failed) {
        failed = true;
        throw new Error('synthetic failure');
      }
      return 0;
    });
    await expect(deleteAccount('test-user')).rejects.toMatchObject({
      statusCode: 503,
      code: 'ACCOUNT_DELETION_FAILED',
    });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.deleteByField).not.toHaveBeenCalledWith('profiles', '__id__', 'test-user');
    await expect(deleteAccount('test-user')).resolves.toBeUndefined();
    expect(mocks.markDeletion).toHaveBeenCalledTimes(2);
    expect(mocks.deleteUser).toHaveBeenCalledTimes(1);
  });

  it('retries a Firebase-only failure and accepts an already absent Firebase user', async () => {
    mocks.deleteUser
      .mockRejectedValueOnce({ code: 'auth/internal-error' })
      .mockRejectedValueOnce({ code: 'auth/user-not-found' });
    await expect(deleteAccount('test-user')).rejects.toMatchObject({ statusCode: 503 });
    mocks.getUser.mockRejectedValue({ code: 'auth/user-not-found' });
    mocks.revokeRefreshTokens.mockRejectedValue({ code: 'auth/user-not-found' });
    await expect(deleteAccount('test-user')).resolves.toBeUndefined();
  });
});
