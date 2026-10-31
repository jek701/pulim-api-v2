import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  tail: Promise.resolve(),
}));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }),
  documentKey: (query: { table: string }, id: string) => ({ ...query, id }),
  filterQuery: (query: { table: string }, field: string, _op: string, value: unknown) => ({
    ...query,
    field,
    value,
  }),
  runSqlTransaction: async (work: (tx: unknown) => Promise<unknown>) => {
    const previous = memory.tail;
    let release!: () => void;
    memory.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const next = new Map(memory.rows);
      let writing = false;
      const result = await work({
        read: async (query: { table: string; id?: string; field?: string; value?: unknown }) => {
          if (writing) throw new Error('Read all records before scheduling writes');
          if (query.id !== undefined) {
            const data = next.get(`${query.table}:${query.id}`);
            return { exists: !!data, data, id: query.id };
          }
          const rows = [...next.entries()].filter(
            ([key, value]) =>
              key.startsWith(`${query.table}:`) && value[query.field!] === query.value,
          );
          return { rows, size: rows.length, empty: rows.length === 0 };
        },
        insert: (key: { table: string; id: string }, data: Record<string, unknown>) => {
          writing = true;
          const composite = `${key.table}:${key.id}`;
          if (next.has(composite)) throw new Error('Duplicate id');
          next.set(composite, data);
        },
        save: (key: { table: string; id: string }, data: Record<string, unknown>) => {
          writing = true;
          next.set(`${key.table}:${key.id}`, data);
        },
      });
      memory.rows = next;
      return result;
    } finally {
      release();
    }
  },
}));

import { guestImportSchema, planGuestImport } from '../../src/domain/guestImport';
import { importGuestSnapshot } from '../../src/services/guestImport.service';

const batch = () =>
  guestImportSchema.parse({
    importId: '64c5f3ce-9666-4414-b0b5-1efc6b52c634',
    cards: [
      {
        id: 'guest-card-1',
        cardType: 'debit',
        name: 'Card',
        bank: '',
        currency: 'UZS',
        balance: 800,
        createdAt: 1,
        userId: 'attacker',
        householdId: 'other-household',
      },
    ],
    categories: [
      {
        id: 'guest__default__expense_food',
        name: 'Food',
        type: 'expense',
        icon: 'food',
        color: '#fff',
        createdAt: 1,
      },
    ],
    subcategories: [],
    transactions: [
      {
        id: 'guest-tx-1',
        amount: 300,
        currency: 'UZS',
        type: 'expense',
        categoryId: 'guest__default__expense_food',
        cardId: 'guest-card-1',
        date: 2,
        createdAt: 2,
        returnedAmount: 100,
      },
      {
        id: 'guest-tx-2',
        amount: 100,
        currency: 'UZS',
        type: 'income',
        source: 'return',
        linkedTransactionId: 'guest-tx-1',
        categoryId: 'guest__default__expense_food',
        cardId: 'guest-card-1',
        date: 3,
        createdAt: 3,
      },
    ],
    subscriptions: [],
    settings: { cardOrder: ['guest-card-1'] },
  });

beforeEach(() => {
  memory.rows.clear();
  memory.rows.set('profiles:u1', { isPremium: false });
});

describe('guest snapshot import', () => {
  it('keeps final balances and refund links without replaying any balance delta', async () => {
    const result = await importGuestSnapshot('u1', batch());
    expect(memory.rows.get(`cards:${result.idMap['guest-card-1']}`)).toMatchObject({
      balance: 800,
      userId: 'u1',
      scope: 'personal',
    });
    expect(memory.rows.get(`cards:${result.idMap['guest-card-1']}`)).not.toHaveProperty(
      'householdId',
    );
    expect(memory.rows.get(`transactions:${result.idMap['guest-tx-2']}`)).toMatchObject({
      linkedTransactionId: result.idMap['guest-tx-1'],
      cardId: result.idMap['guest-card-1'],
    });
    expect(result.idMap['guest__default__expense_food']).toBe('u1__default__expense_food');
  });

  it('makes retry and concurrent duplicate requests exactly once', async () => {
    const [first, second] = await Promise.all([
      importGuestSnapshot('u1', batch()),
      importGuestSnapshot('u1', batch()),
    ]);
    expect(second).toEqual(first);
    expect([...memory.rows.keys()].filter((key) => key.startsWith('transactions:'))).toHaveLength(
      2,
    );
    expect((await importGuestSnapshot('u1', batch())).idMap).toEqual(first.idMap);
  });

  it('rejects reusing a receipt for another body without changing any row', async () => {
    await importGuestSnapshot('u1', batch());
    const before = structuredClone(memory.rows);
    const changed = batch();
    changed.cards[0].balance = 999;
    await expect(importGuestSnapshot('u1', changed)).rejects.toMatchObject({
      code: 'GUEST_IMPORT_CONFLICT',
    });
    expect(memory.rows).toEqual(before);
  });

  it('retains existing account balances and categories, and enforces free account limits atomically', async () => {
    memory.rows.set('cards:existing', { userId: 'u1', balance: 500 });
    const before = structuredClone(memory.rows);
    await expect(importGuestSnapshot('u1', batch())).rejects.toMatchObject({
      code: 'GUEST_IMPORT_LIMIT',
    });
    expect(memory.rows).toEqual(before);
    memory.rows.set('profiles:u1', {
      isPremium: true,
      subscription: { premiumUntil: Date.now() + 60_000 },
    });
    memory.rows.set('categories:u1__default__expense_food', { userId: 'u1', name: 'My Food' });
    await importGuestSnapshot('u1', batch());
    expect(memory.rows.get('cards:existing')!.balance).toBe(500);
    expect(memory.rows.get('categories:u1__default__expense_food')!.name).toBe('My Food');
  });

  it('uses account-specific ids and rejects unsupported custom categories or duplicate ids', () => {
    const payload = batch();
    expect(planGuestImport('u1', payload).result.idMap['guest-card-1']).not.toEqual(
      planGuestImport('u2', payload).result.idMap['guest-card-1'],
    );
    payload.categories[0].id = 'custom';
    expect(() => planGuestImport('u1', payload)).toThrow('Only starter');
    const wrongCategoryType = batch();
    wrongCategoryType.categories[0].type = 'income';
    expect(() => planGuestImport('u1', wrongCategoryType)).toThrow('Only starter');
    const duplicate = batch();
    duplicate.transactions[1].id = duplicate.transactions[0].id;
    expect(() => planGuestImport('u1', duplicate)).toThrow('Duplicate');
  });

  it('returns stable self-mappings for built-in category ids', () => {
    const payload = batch();
    payload.transactions[0].categoryId = '__subscription__';
    payload.transactions[0].source = 'subscription';
    expect(planGuestImport('u1', payload).result.idMap['__subscription__']).toBe(
      '__subscription__',
    );
  });

  it('rejects premium injection and nonfinite money', () => {
    expect(guestImportSchema.safeParse({ ...batch(), isPremium: true }).success).toBe(false);
    const payload = batch();
    payload.transactions[0].amount = Infinity;
    expect(guestImportSchema.safeParse(payload).success).toBe(false);
  });
});
