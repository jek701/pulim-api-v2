import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ learn: vi.fn(), ready: vi.fn(), read: vi.fn(), issued: vi.fn(), siblings: vi.fn() }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }), filterQuery: (query: any) => query, readDocument: mocks.read,
}));
vi.mock('../../src/capture/categories', () => ({ learnCaptureTransaction: mocks.learn }));
vi.mock('../../src/capture/repository', () => ({
  isCaptureStorageReady: mocks.ready, getIssuedMerchant: mocks.issued, receiptSiblings: mocks.siblings,
}));
import { dominantCategory, learnCommittedCapture } from '../../src/capture/learning';

const capture = { kind: 'receipt_soliq' as const, merchantTin: '123456789', suggestedCategoryId: 'food', receiptKey: 'a'.repeat(64) };
const write = { capture, categoryId: 'transport', type: 'expense' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ready.mockResolvedValue(true);
  mocks.issued.mockResolvedValue({ source: 'soliq', suggestedCategoryId: 'food', draftId: 'd' });
  mocks.siblings.mockResolvedValue([]);
  mocks.read.mockResolvedValue({ rows: [{ id: 'food', data: { name: 'Food', type: 'expense', userId: 'user' } }] });
  mocks.learn.mockResolvedValue(undefined);
});

describe('learning after commit', () => {
  it('passes the committed category, the issued suggestion and the owner’s own categories', async () => {
    await learnCommittedCapture('user', 'tx-1', write);
    expect(mocks.learn).toHaveBeenCalledWith({
      uid: 'user', transactionId: 'tx-1', categoryId: 'transport', merchantTin: '123456789', suggestedCategoryId: 'food',
      shared: true, receiptKey: 'a'.repeat(64), categories: [expect.objectContaining({ id: 'food', name: 'Food' })],
    });
  });

  it.each([
    ['voice captures without a merchant', { capture: { kind: 'voice' as const }, categoryId: 'food', type: 'expense' }],
    ['writes without a category', { capture, categoryId: undefined, type: 'expense' }],
    ['legacy clients without capture', { categoryId: 'food', type: 'expense' }],
    ['income (including refunds)', { capture, categoryId: 'food', type: 'income' }],
  ])('does nothing for %s', async (_name, input) => {
    await learnCommittedCapture('user', 'tx-1', input);
    expect(mocks.learn).not.toHaveBeenCalled();
  });

  it('learns only a TIN this server issued to this user (a made-up or other user’s TIN is ignored)', async () => {
    mocks.issued.mockResolvedValue(undefined);
    await learnCommittedCapture('user', 'tx-1', write);
    expect(mocks.issued).toHaveBeenCalledWith('user', '123456789');
    expect(mocks.learn).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('awards the double weight only for the suggestion that was actually issued', async () => {
    await learnCommittedCapture('user', 'tx-1', { ...write, capture: { ...capture, suggestedCategoryId: 'something-else' } });
    expect(mocks.learn.mock.calls[0][0].suggestedCategoryId).toBeUndefined();
    mocks.issued.mockResolvedValue({ source: 'soliq', suggestedCategoryId: null, draftId: 'd' });
    await learnCommittedCapture('user', 'tx-2', { ...write, capture: { ...capture, suggestedCategoryId: 'food' } });
    expect(mocks.learn.mock.calls[1][0].suggestedCategoryId).toBeUndefined();
  });

  it('keeps a photo receipt’s TIN out of the shared directory', async () => {
    mocks.issued.mockResolvedValue({ source: 'photo', suggestedCategoryId: 'food', draftId: 'd' });
    await learnCommittedCapture('user', 'tx-1', { ...write, capture: { ...capture, kind: 'receipt_photo' } });
    expect(mocks.learn.mock.calls[0][0].shared).toBe(false);
  });

  it('votes once per receipt with the category that has the most money when it was split', async () => {
    mocks.siblings.mockResolvedValue([
      { categoryId: 'food', amount: 30000, type: 'expense' },
      { categoryId: 'shopping', amount: 12000, type: 'expense' },
      { categoryId: 'food', amount: 5000, type: 'expense' },
      { categoryId: 'transport', amount: 99999, type: 'income' },
    ]);
    // The draft being committed is the small one; the receipt's category is still food.
    await learnCommittedCapture('user', 'tx-2', { ...write, categoryId: 'shopping' });
    expect(mocks.siblings).toHaveBeenCalledWith('user', 'a'.repeat(64));
    expect(mocks.learn.mock.calls[0][0].categoryId).toBe('food');
  });

  it('breaks ties between split categories deterministically', () => {
    expect(dominantCategory([{ categoryId: 'b', amount: 5, type: 'expense' }, { categoryId: 'a', amount: 5, type: 'expense' }])).toBe('a');
    expect(dominantCategory([])).toBeNull();
    expect(dominantCategory([{ categoryId: 'a', amount: 5, type: 'income' }])).toBeNull();
  });

  it('does nothing until the migration is applied', async () => {
    mocks.ready.mockResolvedValue(false);
    await learnCommittedCapture('user', 'tx-1', write);
    expect(mocks.issued).not.toHaveBeenCalled();
    expect(mocks.learn).not.toHaveBeenCalled();
  });

  it('propagates failures to the caller, which swallows and logs them (never the user write)', async () => {
    mocks.learn.mockRejectedValue(new Error('deadlock'));
    await expect(learnCommittedCapture('user', 'tx-1', write)).rejects.toThrow('deadlock');
  });
});
