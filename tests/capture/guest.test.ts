import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/services/transaction.service', () => ({ createTransaction: mocks.create }));
import { createTransaction } from '../../src/controllers/transactions.controller';

const body = { amount: 1000, currency: 'UZS', type: 'expense', categoryId: 'food', date: 1,
  capture: { kind: 'receipt_soliq', merchantTin: '123456789', receiptKey: 'a'.repeat(64) } };
const run = async (provider: string) => {
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  createTransaction({ uid: 'u', body: { ...body }, claims: { firebase: { sign_in_provider: provider } } } as any, res, vi.fn());
  await vi.waitFor(() => expect(res.json).toHaveBeenCalled());
  return res;
};
beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ id: 't' }); });

describe('guests and capture metadata', () => {
  it('drops capture metadata for an anonymous (guest) user, so nothing is stored or learned', async () => {
    await run('anonymous');
    expect(mocks.create.mock.calls[0][1]).not.toHaveProperty('capture');
    expect(mocks.create.mock.calls[0][1]).toMatchObject({ amount: 1000, categoryId: 'food' });
  });
  it('keeps it for signed-in users', async () => {
    await run('password');
    expect(mocks.create.mock.calls[0][1].capture).toMatchObject({ kind: 'receipt_soliq' });
  });
});
