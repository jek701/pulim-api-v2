import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ learn: vi.fn(), ready: vi.fn(), read: vi.fn() }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }), filterQuery: (query: any) => query, readDocument: mocks.read,
}));
vi.mock('../../src/capture/categories', () => ({ learnCaptureTransaction: mocks.learn }));
vi.mock('../../src/capture/repository', () => ({ isCaptureStorageReady: mocks.ready }));
import { learnCommittedCapture } from '../../src/capture/learning';

const capture = { kind: 'receipt_soliq' as const, merchantTin: '123456789', suggestedCategoryId: 'food' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ready.mockResolvedValue(true);
  mocks.read.mockResolvedValue({ rows: [{ id: 'food', data: { name: 'Food', type: 'expense', userId: 'user' } }] });
  mocks.learn.mockResolvedValue(undefined);
});

describe('learning after commit', () => {
  it('passes the committed category, the suggestion and the owner’s own categories', async () => {
    await learnCommittedCapture('user', 'tx-1', { capture, categoryId: 'transport' });
    expect(mocks.learn).toHaveBeenCalledWith({
      uid: 'user', transactionId: 'tx-1', categoryId: 'transport', merchantTin: '123456789', suggestedCategoryId: 'food',
      categories: [expect.objectContaining({ id: 'food', name: 'Food' })],
    });
  });

  it.each([
    ['voice captures without a merchant', { capture: { kind: 'voice' as const }, categoryId: 'food' }],
    ['writes without a category', { capture, categoryId: undefined }],
    ['legacy clients without capture', { categoryId: 'food' }],
  ])('does nothing for %s', async (_name, input) => {
    await learnCommittedCapture('user', 'tx-1', input);
    expect(mocks.learn).not.toHaveBeenCalled();
  });

  it('does nothing until the migration is applied', async () => {
    mocks.ready.mockResolvedValue(false);
    await learnCommittedCapture('user', 'tx-1', { capture, categoryId: 'food' });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.learn).not.toHaveBeenCalled();
  });

  it('propagates failures to the caller, which swallows and logs them (never the user write)', async () => {
    mocks.learn.mockRejectedValue(new Error('deadlock'));
    await expect(learnCommittedCapture('user', 'tx-1', { capture, categoryId: 'food' })).rejects.toThrow('deadlock');
  });
});
