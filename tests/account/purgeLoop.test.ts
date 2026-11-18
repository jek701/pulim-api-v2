import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listPendingAccountDeletions: vi.fn(), purgeAccount: vi.fn(), warn: vi.fn(),
  env: { ACCOUNT_DELETION_GRACE_DAYS: 30, BACKGROUND_JOBS_ENABLED: true, MAINTENANCE_MODE: false },
}));
vi.mock('../../src/config/env', () => ({ env: mocks.env }));
vi.mock('../../src/db/accountDeletion', () => mocks);
vi.mock('../../src/services/accountDeletion.service', () => mocks);
vi.mock('../../src/utils/logger', () => ({ logger: { warn: mocks.warn } }));
import { runAccountPurges, startAccountPurgeLoop } from '../../src/services/accountPurge.loop';

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(mocks.env, { ACCOUNT_DELETION_GRACE_DAYS: 30, BACKGROUND_JOBS_ENABLED: true, MAINTENANCE_MODE: false });
  mocks.listPendingAccountDeletions.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('account purge worker', () => {
  it('queries the grace cutoff and batch limit, processes sequentially and retries failures next tick', async () => {
    mocks.listPendingAccountDeletions.mockResolvedValue([{ uid: 'old1' }, { uid: 'old2' }]);
    let active = false;
    mocks.purgeAccount.mockImplementation(async () => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
    }).mockRejectedValueOnce(new Error('sensitive uid/SQL'));
    const now = 40 * 86400000;
    await runAccountPurges(now);
    expect(mocks.listPendingAccountDeletions).toHaveBeenCalledWith(10 * 86400000, 20);
    expect(mocks.purgeAccount.mock.calls).toEqual([['old1'], ['old2']]);
    expect(mocks.warn).toHaveBeenCalledWith({ uidHash: expect.stringMatching(/^[a-f0-9]{64}$/) }, 'account.purge_failed');
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('old1');
    await runAccountPurges(now);
    expect(mocks.purgeAccount.mock.calls).toEqual([['old1'], ['old2'], ['old1'], ['old2']]);
  });

  it('supports a zero-day grace period', async () => {
    mocks.env.ACCOUNT_DELETION_GRACE_DAYS = 0;
    await runAccountPurges(12345);
    expect(mocks.listPendingAccountDeletions).toHaveBeenCalledWith(12345, 20);
  });

  it.each(['BACKGROUND_JOBS_ENABLED', 'MAINTENANCE_MODE'] as const)('respects %s', async (key) => {
    mocks.env[key] = key === 'MAINTENANCE_MODE';
    await runAccountPurges();
    expect(mocks.listPendingAccountDeletions).not.toHaveBeenCalled();
  });

  it('runs immediately and hourly, prevents overlap and awaits in-flight purge on stop', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.listPendingAccountDeletions.mockResolvedValue([{ uid: 'old1' }, { uid: 'old2' }]);
    mocks.purgeAccount.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const loop = startAccountPurgeLoop();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(mocks.purgeAccount).toHaveBeenCalledTimes(1);
    expect(mocks.listPendingAccountDeletions).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(mocks.purgeAccount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600000);
    expect(mocks.listPendingAccountDeletions).toHaveBeenCalledTimes(1);
  });

  it('continues at the next hourly tick after a selection failure', async () => {
    vi.useFakeTimers();
    mocks.listPendingAccountDeletions.mockRejectedValueOnce(new Error('SQL details'));
    const loop = startAccountPurgeLoop();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(mocks.warn).toHaveBeenCalledWith('account.purge_worker_failed');
    expect(mocks.listPendingAccountDeletions).toHaveBeenCalledTimes(2);
    await loop.stop();
  });
});
