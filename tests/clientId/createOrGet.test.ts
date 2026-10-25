import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Key = { table: string; id: string };

// Placeholder config so src/config/env validates without a local .env (no real values).
vi.hoisted(() => {
  process.env.FIREBASE_PROJECT_ID ??= 'test-project';
  process.env.TELEGRAM_BOT_TOKEN ??= 'TELEGRAM_BOT_TOKEN_PLACEHOLDER';
});

/** In-memory tables plus a log of every buffered write of the last transaction. */
const store = vi.hoisted(() => ({
  tables: new Map<string, Map<string, Row>>(),
  writes: [] as Array<{ kind: string; key: Key; data?: Row }>,
}));

vi.mock('../../src/db/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/documents')>();
  const rowsFor = (table: string) => {
    if (!store.tables.has(table)) store.tables.set(table, new Map());
    return store.tables.get(table)!;
  };
  const read = async (key: Key) => {
    const data = rowsFor(key.table).get(key.id);
    return { id: key.id, key, exists: !!data, data: data ? structuredClone(data) : undefined };
  };
  return {
    ...actual,
    readDocument: read,
    runSqlTransaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const writes: Array<{ kind: string; key: Key; data?: Row }> = [];
      const push = (kind: string) => (key: Key, data?: Row) => {
        writes.push({ kind, key, data });
      };
      const result = await work({
        read: async (key: Key) => {
          if (writes.length) throw new Error('Read all records before scheduling writes');
          return read(key);
        },
        save: push('save'),
        insert: push('insert'),
        patch: push('patch'),
        remove: push('remove'),
      });
      store.writes = writes;
      for (const write of writes) {
        const rows = rowsFor(write.key.table);
        if (write.kind === 'insert' && rows.has(write.key.id)) throw new Error('Record already exists');
        if (write.kind === 'insert' || write.kind === 'save') rows.set(write.key.id, write.data!);
      }
      return result;
    },
  };
});
vi.mock('../../src/notifications/queue.repository', () => ({
  scheduleBudgetCheck: async () => undefined,
}));

const txService = await import('../../src/services/transaction.service');
const { refillCreditCard } = await import('../../src/services/card.service');
const { createDebt } = await import('../../src/services/debt.service');
const { userScopedRepo } = await import('../../src/repositories/base.repository');

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const put = (table: string, id: string, data: Row) => {
  if (!store.tables.has(table)) store.tables.set(table, new Map());
  store.tables.get(table)!.set(id, data);
};
const expense = {
  amount: 1000,
  currency: 'UZS',
  type: 'expense',
  categoryId: 'food',
  cardId: 'card1',
  date: 1,
};

beforeEach(() => {
  store.tables.clear();
  store.writes = [];
  put('cards', 'card1', { userId: 'u1', cardType: 'debit', currency: 'UZS', name: 'Humo', balance: 5000 });
  put('cards', 'credit1', { userId: 'u1', cardType: 'credit', currency: 'UZS', name: 'Visa', balance: -100 });
});

describe('createTransaction with a client id', () => {
  it('creates at the client id with insert, without storing the id in the body', async () => {
    const created = await txService.createTransaction('u1', { ...expense, id: ID });
    expect(created.id).toBe(ID);
    const insert = store.writes.find((w) => w.key.table === 'transactions');
    expect(insert).toMatchObject({ kind: 'insert', key: { id: ID } });
    expect(insert!.data).not.toHaveProperty('id');
    expect(store.writes.some((w) => w.kind === 'patch' && w.key.id === 'card1')).toBe(true);
  });

  it('replays an existing own document with no writes at all', async () => {
    put('transactions', ID, { ...expense, amount: 7, userId: 'u1', createdAt: 5 });
    const replay = await txService.createTransaction('u1', { ...expense, id: ID });
    expect(store.writes).toEqual([]);
    // Stored document wins; the payload is not compared.
    expect(replay).toEqual({ id: ID, ...expense, amount: 7, userId: 'u1', createdAt: 5 });
  });

  it('rejects an id owned by another user or a household with 409 ID_CONFLICT', async () => {
    for (const owner of ['u2', 'household:h1']) {
      put('transactions', ID, { ...expense, userId: owner });
      await expect(txService.createTransaction('u1', { ...expense, id: ID })).rejects.toMatchObject({
        statusCode: 409,
        code: 'ID_CONFLICT',
        message: 'This id cannot be used.',
      });
      expect(store.writes).toEqual([]);
    }
  });

  it('keeps server ids when no id is sent', async () => {
    const created = await txService.createTransaction('u1', { ...expense });
    expect(created.id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(store.writes.find((w) => w.key.table === 'transactions')?.kind).toBe('save');
  });
});

describe('other money creates replay without a balance effect', () => {
  it('transfer', async () => {
    put('transactions', ID, { source: 'transfer', userId: 'u1' });
    const replay = await txService.transfer('u1', {
      fromCardId: 'card1',
      toCardId: 'credit1',
      amount: 10,
      id: ID,
    });
    expect(replay).toEqual({ id: ID, source: 'transfer', userId: 'u1' });
    expect(store.writes).toEqual([]);
  });

  it('return: a replayed full refund does not trip the remaining-amount check', async () => {
    put('transactions', 'orig', { ...expense, userId: 'u1', returnedAmount: 1000 });
    put('transactions', ID, { source: 'return', linkedTransactionId: 'orig', userId: 'u1' });
    const replay = await txService.returnTransaction('u1', 'orig', { returnAmount: 1000, id: ID });
    expect(replay.id).toBe(ID);
    expect(store.writes).toEqual([]);
  });

  it('refill', async () => {
    put('transactions', ID, { source: 'transfer', userId: 'u1' });
    await refillCreditCard('u1', { creditCardId: 'credit1', sourceCardId: 'card1', amount: 5, id: ID });
    expect(store.writes).toEqual([]);
  });

  it('debt: replay writes neither the debt nor its cash transaction', async () => {
    put('debts', ID, { person: 'Ali', userId: 'u1' });
    const input = { direction: 'i_owe' as const, person: 'Ali', amount: 5, currency: 'UZS' };
    await createDebt('u1', { ...input, accountId: 'card1', id: ID });
    expect(store.writes).toEqual([]);
  });

  it('debt: first create uses the client id for the debt and a server id for its transaction', async () => {
    const input = { direction: 'i_owe' as const, person: 'Ali', amount: 5, currency: 'UZS' };
    const debt = await createDebt('u1', { ...input, accountId: 'card1', id: ID });
    expect(debt.id).toBe(ID);
    const debtWrite = store.writes.find((w) => w.key.table === 'debts')!;
    expect(debtWrite.kind).toBe('insert');
    expect(debtWrite.data).not.toHaveProperty('id');
    const txWrite = store.writes.find((w) => w.key.table === 'transactions')!;
    expect(txWrite.key.id).not.toBe(ID);
    expect(txWrite.data).toMatchObject({ debtId: ID });
  });
});

describe('userScopedRepo.create with a client id', () => {
  const repo = userScopedRepo('categories');
  const body = { name: 'Pets', icon: 'paw', color: 'red', type: 'expense' };

  it('inserts at the id and returns { id, ...doc } without an id field in storage', async () => {
    const created = await repo.create('u1', { ...body, id: ID }, { extra: 1 });
    expect(created).toMatchObject({ id: ID, ...body, extra: 1, userId: 'u1' });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({ kind: 'insert', key: { table: 'categories', id: ID } });
    expect(store.tables.get('categories')!.get(ID)).not.toHaveProperty('id');
  });

  it('returns the existing own doc without writing', async () => {
    put('categories', ID, { ...body, name: 'Old', userId: 'u1', createdAt: 1 });
    const replay = await repo.create('u1', { ...body, id: ID });
    expect(replay).toEqual({ id: ID, ...body, name: 'Old', userId: 'u1', createdAt: 1 });
    expect(store.writes).toEqual([]);
  });

  it('409 on a foreign id', async () => {
    put('categories', ID, { ...body, userId: 'u2' });
    await expect(repo.create('u1', { ...body, id: ID })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ID_CONFLICT',
    });
  });
});
