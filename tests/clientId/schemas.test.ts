import { describe, expect, it } from 'vitest';
import { clientIdSchema, isValidClientId } from '../../src/domain/clientId';
import * as schemas from '../../src/domain/schemas';

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

describe('clientIdSchema', () => {
  it.each([
    ['UUIDv4', ID],
    ['ULID', '01JC8Z5Q4N3K2M1P0R9S8T7V6W'],
    ['8 chars', 'abcdefgh'],
    ['64 chars', 'a'.repeat(64)],
    ['single underscores and dashes', 'a_b-c_d-e'],
  ])('accepts %s', (_label, value) => {
    expect(clientIdSchema.safeParse(value).success).toBe(true);
    expect(isValidClientId(value)).toBe(true);
  });

  it.each([
    ['7 chars', 'abcdefg'],
    ['65 chars', 'a'.repeat(65)],
    ['20 alphanumerics (server id shape)', 'AbCdEfGhIjKlMnOpQrSt'],
    ['double underscore', 'a__bcdefgh'],
    ['telegram_ prefix', 'telegram_xxxxxxx'],
    ['space', 'abcd efgh'],
    ['slash', 'abcd/efgh'],
    ['unicode', 'abcdéfgh'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(clientIdSchema.safeParse(value).success).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(clientIdSchema.safeParse(12345678).success).toBe(false);
  });
});

const card = { cardType: 'debit', name: 'Humo', bank: 'Kapital', currency: 'UZS', balance: 0 };
const transaction = {
  amount: 1000,
  currency: 'UZS',
  type: 'expense',
  categoryId: 'c1',
  date: 1,
};
const goal = { name: 'Car', icon: 'car', targetAmount: 100, currency: 'UZS', deadline: 1 };
const subscription = {
  name: 'Netflix',
  icon: 'tv',
  amount: 10,
  currency: 'USD',
  cycle: 'monthly',
  nextBillingDate: 1,
};
const planned = { name: 'Rent', amount: 10, currency: 'UZS', icon: 'home', recurrence: 'monthly' };
const transfer = { fromCardId: 'a', toCardId: 'b', amount: 10 };
const refund = { returnAmount: 5 };

describe('create schemas keep the client id', () => {
  const cases: Array<[string, { safeParse: (v: unknown) => any }, Record<string, unknown>]> = [
    ['categoryCreateSchema', schemas.categoryCreateSchema, { name: 'x', icon: 'i', color: 'c', type: 'expense' }],
    ['subcategoryCreateSchema', schemas.subcategoryCreateSchema, { name: 'x', categoryId: 'c1' }],
    ['cardCreateSchema', schemas.cardCreateSchema, card],
    ['savingsGoalCreateSchema', schemas.savingsGoalCreateSchema, goal],
    ['subscriptionCreateSchema', schemas.subscriptionCreateSchema, subscription],
    ['plannedExpenseCreateSchema', schemas.plannedExpenseCreateSchema, planned],
    ['transactionCreateSchema', schemas.transactionCreateSchema, transaction],
    ['transferSchema', schemas.transferSchema, transfer],
    ['returnSchema', schemas.returnSchema, refund],
    ['refillSchema', schemas.refillSchema, { creditCardId: 'a', sourceCardId: 'b', amount: 1 }],
    [
      'debtCreateSchema',
      schemas.debtCreateSchema,
      { direction: 'i_owe', person: 'p', amount: 1, currency: 'UZS' },
    ],
    [
      'depositCreateSchema',
      schemas.depositCreateSchema,
      {
        bank: 'b',
        amount: 1,
        currency: 'UZS',
        interestRate: 20,
        startDate: 1,
        endDate: 2,
        capitalization: 'monthly',
        showInterest: true,
        isReplenishable: false,
      },
    ],
  ];

  it.each(cases)('%s keeps a valid id', (_name, schema, body) => {
    const parsed = schema.safeParse({ ...body, id: ID });
    expect(parsed.success).toBe(true);
    expect(parsed.data.id).toBe(ID);
  });

  it.each(cases)('%s still works without an id', (_name, schema, body) => {
    const parsed = schema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('id');
  });

  it.each(cases)('%s rejects an invalid id', (_name, schema, body) => {
    expect(schema.safeParse({ ...body, id: 'telegram_abcdefgh' }).success).toBe(false);
  });
});

describe('update and household schemas drop the client id', () => {
  const cases: Array<[string, { safeParse: (v: unknown) => any }, Record<string, unknown>]> = [
    ['cardUpdateSchema', schemas.cardUpdateSchema, { name: 'x' }],
    ['subscriptionUpdateSchema', schemas.subscriptionUpdateSchema, { name: 'x' }],
    ['plannedExpenseUpdateSchema', schemas.plannedExpenseUpdateSchema, { name: 'x' }],
    ['transactionUpdateSchema', schemas.transactionUpdateSchema, { amount: 5 }],
    ['transferUpdateSchema', schemas.transferUpdateSchema, { ...transfer, date: 1 }],
    ['returnUpdateSchema', schemas.returnUpdateSchema, { ...refund, date: 1 }],
    ['savingsGoalUpdateSchema', schemas.savingsGoalUpdateSchema, { name: 'x' }],
    ['debtUpdateSchema', schemas.debtUpdateSchema, { person: 'x' }],
    ['householdCardCreateSchema', schemas.householdCardCreateSchema, card],
    ['householdTransactionCreateSchema', schemas.householdTransactionCreateSchema, transaction],
    ['householdGoalCreateSchema', schemas.householdGoalCreateSchema, goal],
  ];

  it.each(cases)('%s strips id', (_name, schema, body) => {
    const parsed = schema.safeParse({ ...body, id: ID });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('id');
  });
});
