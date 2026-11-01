import { describe, expect, it } from 'vitest';

import {
  householdTransactionCreateSchema,
  transactionCreateSchema,
  transactionUpdateSchema,
} from '../../src/domain/schemas';

const transaction = {
  id: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c',
  amount: 1000,
  currency: 'UZS',
  type: 'expense',
  categoryId: '__subscription__',
  date: 1790000000000,
};
const metadata = { source: 'subscription', sourceLabel: 'Internet' };

describe('historical subscription transaction metadata', () => {
  it('retains subscription origin alongside the existing client id and transaction fields', () => {
    expect(transactionCreateSchema.parse({ ...transaction, ...metadata })).toEqual({
      ...transaction,
      ...metadata,
    });
  });

  it('keeps ordinary transaction creates unchanged when metadata is omitted', () => {
    expect(transactionCreateSchema.parse(transaction)).toEqual(transaction);
  });

  it('accepts a subscription origin without a label', () => {
    expect(transactionCreateSchema.parse({ ...transaction, source: 'subscription' })).toEqual({
      ...transaction,
      source: 'subscription',
    });
  });

  it.each(['transfer', 'return', 'debt_payment', 'savings', 'deposit_interest', 'unknown', ''])(
    'rejects unsupported source %j',
    (source) => {
      expect(transactionCreateSchema.safeParse({ ...transaction, source }).success).toBe(false);
    },
  );

  it('accepts a 500-character label and rejects a longer label', () => {
    expect(
      transactionCreateSchema.safeParse({ ...transaction, ...metadata, sourceLabel: 'x'.repeat(500) }).success,
    ).toBe(true);
    expect(
      transactionCreateSchema.safeParse({ ...transaction, ...metadata, sourceLabel: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('strips origin fields from generic edits, preserving the existing editable shape', () => {
    expect(transactionUpdateSchema.parse({ amount: 500, ...metadata })).toEqual({ amount: 500 });
  });

  it('strips origin fields and the client id from household creates', () => {
    const { id: _id, ...householdTransaction } = transaction;
    expect(householdTransactionCreateSchema.parse({ ...transaction, ...metadata })).toEqual(householdTransaction);
  });
});
