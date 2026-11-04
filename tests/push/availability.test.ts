import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ configured: vi.fn(), execute: vi.fn() }));
vi.mock('../../src/push/apns', () => ({ apnsConfigured: mocks.configured }));
vi.mock('../../src/db/documents', () => ({ SqlTransaction: class {} }));
vi.mock('../../src/repositories/profile.repository', () => ({ profileRef: vi.fn() }));
vi.mock('../../src/notifications/settings', () => ({ notificationDefaults: vi.fn() }));
vi.mock('../../src/db/database', () => ({
  database: () => {
    const query: any = {
      selectFrom: () => query, select: () => query, limit: () => query,
      execute: mocks.execute,
    };
    return query;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.execute.mockResolvedValue([]);
});

describe('push availability', () => {
  it('requires a configured enabled provider before probing storage', async () => {
    mocks.configured.mockReturnValue(false);
    const { pushAvailable } = await import('../../src/push/availability');
    expect(await pushAvailable()).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('advertises push only after the registry check and shares the cached check', async () => {
    const { pushAvailable } = await import('../../src/push/availability');
    expect(await Promise.all([pushAvailable(), pushAvailable()])).toEqual([true, true]);
    expect(await pushAvailable()).toBe(true);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
  it('caches the absent migration without throwing an internal error', async () => {
    mocks.execute.mockRejectedValue({ code: 'ER_NO_SUCH_TABLE' });
    const { pushAvailable } = await import('../../src/push/availability');
    expect(await pushAvailable()).toBe(false);
    expect(await pushAvailable()).toBe(false);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
  it('does not permanently cache database outages as a missing migration', async () => {
    mocks.execute.mockRejectedValueOnce({ code: 'ECONNRESET' });
    const { pushAvailable } = await import('../../src/push/availability');
    await expect(pushAvailable()).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(await pushAvailable()).toBe(true);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
});
