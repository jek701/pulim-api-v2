import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), getUserByEmail: vi.fn(), listPendingAccountDeletions: vi.fn(),
  readDocument: vi.fn(), restoreAccount: vi.fn(), purgeAccount: vi.fn(),
}));
vi.mock('../../src/config/firebaseAuth', () => ({ auth: mocks }));
vi.mock('../../src/config/env', () => ({ env: { ACCOUNT_DELETION_GRACE_DAYS: 30 } }));
vi.mock('../../src/db/accountDeletion', () => mocks);
vi.mock('../../src/db/documents', () => ({ ...mocks, documentKey: (table: string, uid: string) => ({ table, uid }) }));
vi.mock('../../src/db/database', () => ({ closeDatabase: vi.fn() }));
vi.mock('../../src/services/accountDeletion.service', () => mocks);
import { runAccountDeletionCli } from '../../src/cli/accountDeletion';

beforeEach(() => vi.resetAllMocks());

describe('account operator CLI', () => {
  it('lists pending accounts with dates, Firebase providers/email and absent Firebase users', async () => {
    mocks.listPendingAccountDeletions.mockResolvedValue([{ uid: 'apple', requestedAt: 1000 }, { uid: 'gone', requestedAt: 2000 }]);
    mocks.getUser.mockResolvedValueOnce({ uid: 'apple', email: 'relay@example.test', providerData: [{ providerId: 'apple.com' }] })
      .mockRejectedValueOnce({ code: 'auth/user-not-found' });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runAccountDeletionCli(['list']);
      expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual([
        { uid: 'apple', requestedAt: new Date(1000).toISOString(), purgeAt: new Date(1000 + 30 * 86400000).toISOString(), provider: ['apple.com'], email: 'relay@example.test' },
        { uid: 'gone', requestedAt: new Date(2000).toISOString(), purgeAt: new Date(2000 + 30 * 86400000).toISOString(), provider: [], email: null },
      ]);
    } finally { output.mockRestore(); }
  });

  it.each(['relay@example.test', 'apple'])('finds an account by %s', async (value) => {
    const user = { uid: 'apple', email: 'relay@example.test', providerData: [{ providerId: 'apple.com' }] };
    mocks.getUser.mockResolvedValue(user);
    mocks.getUserByEmail.mockResolvedValue(user);
    mocks.readDocument.mockResolvedValue({ exists: true, data: { deletionRequestedAt: 1000 } });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runAccountDeletionCli(['find', value]);
      expect(mocks.readDocument).toHaveBeenCalledWith({ table: 'profiles', uid: 'apple' });
      expect(JSON.parse(String(output.mock.calls[0][0])).uid).toBe('apple');
      if (value.includes('@')) expect(mocks.getUserByEmail).toHaveBeenCalledWith(value);
    } finally { output.mockRestore(); }
  });

  it.each(['restore', 'purge'])('calls the %s service', async (command) => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runAccountDeletionCli([command, 'uid']);
      expect(command === 'restore' ? mocks.restoreAccount : mocks.purgeAccount).toHaveBeenCalledWith('uid');
    } finally { output.mockRestore(); }
  });

  it('rejects invalid commands and propagates failures to the non-zero-exit entrypoint', async () => {
    await expect(runAccountDeletionCli(['purge'])).rejects.toThrow('Usage:');
    await expect(runAccountDeletionCli(['list', 'extra'])).rejects.toThrow('Usage:');
    mocks.restoreAccount.mockRejectedValue(new Error('already purged'));
    await expect(runAccountDeletionCli(['restore', 'uid'])).rejects.toThrow('already purged');
    mocks.getUser.mockRejectedValue({ code: 'auth/user-not-found' });
    mocks.readDocument.mockResolvedValue({ exists: false });
    await expect(runAccountDeletionCli(['find', 'missing'])).rejects.toThrow('Account not found.');
  });
});
