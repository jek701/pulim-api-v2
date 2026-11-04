import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ callbacks: [] as Array<() => void>, existing: null as any,
  writes: [] as any[], committed: false, failure: false, learn: vi.fn(), warn: vi.fn() }));
vi.mock('../../src/capture/learning', () => ({ learnCommittedCapture: state.learn }));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: state.warn } }));
vi.mock('../../src/notifications/queue.repository', () => ({ scheduleBudgetCheck: async () => undefined }));
vi.mock('../../src/db/documents', async original => ({
  ...await original<typeof import('../../src/db/documents')>(),
  runSqlTransaction: async (work: any) => {
    const result = await work({ save: (...args: any[]) => state.writes.push(args), insert: (...args: any[]) => state.writes.push(args),
      afterCommit: (callback: () => void) => state.callbacks.push(callback) });
    if (state.failure) throw new Error('synthetic rollback');
    state.committed = true; state.callbacks.forEach(callback => callback()); return result;
  },
}));
vi.mock('../../src/repositories/sql.helpers', async original => ({
  ...await original<typeof import('../../src/repositories/sql.helpers')>(),
  resolveCreateTarget: async () => ({ ref: { id: 'transaction', table: 'transactions' }, existing: state.existing, clientSupplied: false }),
}));
import { createTransaction } from '../../src/services/transaction.service';
import { transactionCreateSchema, transactionUpdateSchema, householdTransactionCreateSchema } from '../../src/domain/schemas';
const input = { amount: 25000, currency: 'UZS', type: 'expense', categoryId: 'food', date: 1793782800000 };
const capture = { kind: 'receipt_soliq', receiptKey: 'a'.repeat(64), merchantTin: '123456789', suggestedCategoryId: 'food', draftId: '12345678-1234-4234-8234-123456789abc' };
beforeEach(() => { vi.clearAllMocks(); state.callbacks = []; state.existing = null; state.writes = []; state.committed = false; state.failure = false; state.learn.mockResolvedValue(undefined); });
describe('additive capture save metadata and isolated learning', () => {
  it('retains only the approved create metadata and preserves old client bodies', () => {
    expect(transactionCreateSchema.parse(input)).toEqual(input);
    expect(transactionCreateSchema.parse({ ...input, capture })).toEqual({ ...input, capture });
    expect(transactionUpdateSchema.parse({ amount: 100, capture })).toEqual({ amount: 100 });
    expect(householdTransactionCreateSchema.parse({ ...input, capture })).toEqual(input);
  });
  it('never fails a write over capture metadata: strips buyer keys, drops malformed fields', () => {
    expect(transactionCreateSchema.parse({ ...input, capture: { ...capture, phoneNumber: '+998901234567', buyer: 'x' } }))
      .toEqual({ ...input, capture });
    expect(transactionCreateSchema.parse({ ...input, capture: { ...capture, receiptKey: 'raw url with buyer fields', merchantTin: '12' } }))
      .toStrictEqual({ ...input, capture: { kind: capture.kind, suggestedCategoryId: capture.suggestedCategoryId, draftId: capture.draftId } });
    expect(transactionCreateSchema.parse({ ...input, capture: { kind: 'nonsense' } })).toEqual(input);
    expect(transactionCreateSchema.parse({ ...input, capture: 'garbage' })).toEqual(input);
    expect(transactionCreateSchema.parse({ ...input, capture: { ...capture, draftId: 'client-split-1:2' } }).capture?.draftId).toBe('client-split-1:2');
  });
  it('runs learning only after commit and contains a learning rejection', async () => {
    state.learn.mockImplementation(async () => { expect(state.committed).toBe(true); throw new Error('contains buyer data'); });
    expect(await createTransaction('user', { ...input, capture })).toMatchObject({ id: 'transaction', capture });
    await vi.waitFor(() => expect(state.warn).toHaveBeenCalledWith('capture.learning_failed'));
    expect(state.learn).toHaveBeenCalledOnce();
    expect(state.writes).toHaveLength(1);
  });
  it('does not schedule learning for legacy clients, replays or rolled-back writes', async () => {
    await createTransaction('user', input);
    expect(state.callbacks).toHaveLength(0);
    state.existing = { id: 'transaction', ...input, capture };
    await createTransaction('user', { ...input, capture });
    expect(state.callbacks).toHaveLength(0);
    state.existing = null; state.failure = true;
    await expect(createTransaction('user', { ...input, capture })).rejects.toThrow('rollback');
    expect(state.learn).not.toHaveBeenCalled();
  });
});
