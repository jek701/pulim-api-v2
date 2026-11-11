import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  writes: vi.fn(),
  plainReads: vi.fn(),
  lockedScans: vi.fn(),
  locked: vi.fn(),
  select(key: any) {
    return {
      rows: [...state.rows.entries()]
        .filter(([id, data]) => id.startsWith(`${key.table}/`) && data[key.field] === key.value)
        .map(([id, data]) => {
          const rowId = id.split('/')[1];
          return { id: rowId, key: { table: key.table, id: rowId }, data: structuredClone(data) };
        }),
    };
  },
}));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }),
  documentKey: (query: any, id: string) => ({ table: query.table, id }),
  filterQuery: (query: any, field: string, _op: string, value: string) => ({
    ...query,
    field,
    value,
  }),
  patchValue: { increment: (n: number) => ({ inc: n }) },
  readDocument: async (key: any) => {
    state.plainReads(key);
    return state.select(key);
  },
  runSqlTransaction: async (work: any) =>
    work({
      read: async (key: any) => {
        if (key.field) {
          state.lockedScans();
          return state.select(key);
        }
        state.locked(key);
        const data = state.rows.get(`${key.table}/${key.id}`);
        return { exists: !!data, data: structuredClone(data), key };
      },
      patch: (key: any, patch: any) => {
        state.writes(key, patch);
        Object.assign(state.rows.get(`${key.table}/${key.id}`), patch);
      },
      save: vi.fn(() => {
        throw new Error('Unexpected save');
      }),
      insert: vi.fn(() => {
        throw new Error('Unexpected insert');
      }),
      remove: (key: any) => state.rows.delete(`${key.table}/${key.id}`),
    }),
}));

import {
  linkPlannedExpense,
  unlinkPlannedExpense,
} from '../../src/services/plannedExpense.service';
import {
  plannedExpenseCreateSchema,
  plannedExpenseLinkSchema,
  plannedExpenseUnlinkSchema,
  plannedExpenseUpdateSchema,
} from '../../src/domain/schemas';

const day = '2026-11-14';
const link = () => linkPlannedExpense('u', 'plan', { day, transactionId: 'tx' });
const unlink = (transactionId = 'tx') => unlinkPlannedExpense('u', 'plan', { day, transactionId });
const plan = () => state.rows.get('planned_expenses/plan');
beforeEach(() => {
  state.rows.clear();
  state.writes.mockClear();
  state.plainReads.mockClear();
  state.lockedScans.mockClear();
  state.locked.mockClear();
  state.rows.set('planned_expenses/plan', {
    userId: 'u',
    name: 'Rent',
    amount: 100,
    currency: 'UZS',
    skipped: ['2026-11-15'],
  });
  state.rows.set('transactions/tx', { userId: 'u', type: 'expense', amount: 50, cardId: 'card' });
  state.rows.set('cards/card', { userId: 'u', balance: 1000 });
});

describe('planned expense link/unlink', () => {
  it('links an existing expense, returns the full plan and changes only paid', async () => {
    const before = structuredClone(state.rows);
    expect(await link()).toEqual({
      id: 'plan',
      ...before.get('planned_expenses/plan'),
      paid: { [day]: 'tx' },
      linkedDays: [day],
    });
    expect(state.writes).toHaveBeenCalledExactlyOnceWith(
      { table: 'planned_expenses', id: 'plan' },
      { paid: { [day]: 'tx' }, linkedDays: [day] },
    );
    expect(state.lockedScans).not.toHaveBeenCalled();
    expect(state.plainReads).toHaveBeenCalledTimes(1);
    expect(state.rows.size).toBe(before.size);
    expect(state.rows.get('transactions/tx')).toEqual(before.get('transactions/tx'));
    expect(state.rows.get('cards/card')).toEqual(before.get('cards/card'));
  });
  it('links income to an income plan', async () => {
    plan().kind = 'income';
    state.rows.get('transactions/tx').type = 'income';
    expect((await link()).paid).toEqual({ [day]: 'tx' });
  });
  it('repeats link without writes', async () => {
    const first = await link();
    state.writes.mockClear();
    expect(await link()).toEqual(first);
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('unlinks only the requested day and repeats without writes', async () => {
    plan().paid = { [day]: 'tx', '2026-11-16': 'other' };
    plan().linkedDays = [day, '2026-11-16'];
    const before = structuredClone(state.rows);
    const result = await unlink();
    expect(result).toEqual({
      id: 'plan',
      ...before.get('planned_expenses/plan'),
      paid: { '2026-11-16': 'other' },
      linkedDays: ['2026-11-16'],
    });
    expect(plan().linkedDays).toEqual(['2026-11-16']);
    expect(state.rows.get('transactions/tx')).toEqual(before.get('transactions/tx'));
    expect(state.rows.get('cards/card')).toEqual(before.get('cards/card'));
    expect(state.rows.size).toBe(before.size);
    state.writes.mockClear();
    expect(await unlink()).toEqual(result);
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('unlinks a plan with no paid map without changing it', async () => {
    expect(await unlink()).toEqual({ id: 'plan', ...plan(), linkedDays: [] });
    expect(state.writes).not.toHaveBeenCalled();
  });
  it.each([link, unlink])('hides missing and foreign plans with 404', async (action) => {
    plan().userId = 'foreign';
    await expect(action()).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    state.rows.delete('planned_expenses/plan');
    await expect(action()).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('rejects foreign, missing and physically deleted transactions', async () => {
    state.rows.get('transactions/tx').userId = 'foreign';
    await expect(link()).rejects.toMatchObject({ statusCode: 404, code: 'TRANSACTION_NOT_FOUND' });
    state.rows.delete('transactions/tx');
    await expect(link()).rejects.toMatchObject({ statusCode: 404, code: 'TRANSACTION_NOT_FOUND' });
    expect(state.writes).not.toHaveBeenCalled();
  });
  it.each(['income', 'transfer', 'return'])(
    'rejects mismatching transaction type %s',
    async (type) => {
      state.rows.get('transactions/tx').type = type;
      await expect(link()).rejects.toMatchObject({ statusCode: 400, code: 'TRANSACTION_MISMATCH' });
      expect(state.writes).not.toHaveBeenCalled();
    },
  );
  it('rejects expense for an income plan', async () => {
    plan().kind = 'income';
    await expect(link()).rejects.toMatchObject({ statusCode: 400, code: 'TRANSACTION_MISMATCH' });
  });
  it('rejects an already settled occurrence', async () => {
    plan().paid = { [day]: 'other' };
    await expect(link()).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_SETTLED' });
    expect(state.writes).not.toHaveBeenCalled();
  });
  it.each([
    ['plan', '2026-11-16'],
    ['another', '2026-11-16'],
    ['another', day],
  ])('rejects a transaction already linked in %s on %s', async (id, linkedDay) => {
    if (id === 'plan') plan().paid = { [linkedDay]: 'tx' };
    else state.rows.set(`planned_expenses/${id}`, { ...plan(), paid: { [linkedDay]: 'tx' } });
    await expect(link()).rejects.toMatchObject({ statusCode: 409, code: 'TRANSACTION_LINKED' });
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('ignores links in another user’s plans', async () => {
    state.rows.set('planned_expenses/foreign', { userId: 'other', paid: { [day]: 'tx' } });
    expect((await link()).paid).toEqual({ [day]: 'tx' });
  });
  it('does not lock the user plans during the TRANSACTION_LINKED scan', async () => {
    state.rows.set('planned_expenses/another', { ...plan(), paid: { [day]: 'tx' } });
    await expect(link()).rejects.toMatchObject({ code: 'TRANSACTION_LINKED' });
    expect(state.lockedScans).not.toHaveBeenCalled();
    expect(state.plainReads).toHaveBeenCalledTimes(1);
    expect(state.locked.mock.calls.map(([k]) => `${k.table}/${k.id}`).sort()).toEqual([
      'planned_expenses/plan',
      'transactions/tx',
    ]);
  });
  it('does not add the day again on an idempotent repeat of a settle-created entry', async () => {
    plan().paid = { [day]: 'tx' };
    expect((await link()).linkedDays).toEqual([]);
    expect(state.writes).not.toHaveBeenCalled();
    expect(plan().linkedDays).toBeUndefined();
  });
  it('keeps existing linked days without duplicates', async () => {
    plan().linkedDays = ['2026-11-01'];
    expect((await link()).linkedDays).toEqual(['2026-11-01', day]);
  });
  it('rejects unlink with another transaction id (LINK_MISMATCH) without changes', async () => {
    await link();
    state.writes.mockClear();
    await expect(unlink('other')).rejects.toMatchObject({ statusCode: 409, code: 'LINK_MISMATCH' });
    expect(state.writes).not.toHaveBeenCalled();
    expect(plan().paid).toEqual({ [day]: 'tx' });
    expect(plan().linkedDays).toEqual([day]);
  });
  it('rejects unlink of a settle-created day (NOT_LINKED) without changes', async () => {
    plan().paid = { [day]: 'tx' };
    plan().linkedDays = ['2026-11-01'];
    await expect(unlink()).rejects.toMatchObject({ statusCode: 409, code: 'NOT_LINKED' });
    expect(state.writes).not.toHaveBeenCalled();
    expect(plan().paid).toEqual({ [day]: 'tx' });
    expect(plan().linkedDays).toEqual(['2026-11-01']);
  });
  it('unlink with an absent entry is a 200 even for another transaction id', async () => {
    expect((await unlink('whatever')).paid).toBeUndefined();
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('unlink clears both fields', async () => {
    await link();
    const result = await unlink();
    expect(result.paid).toEqual({});
    expect(result.linkedDays).toEqual([]);
    expect(plan().paid).toEqual({});
    expect(plan().linkedDays).toEqual([]);
  });
  it('allows the transaction to be linked again after unlinking', async () => {
    await link();
    await unlink();
    expect(
      (await linkPlannedExpense('u', 'plan', { day: '2026-11-16', transactionId: 'tx' })).paid,
    ).toEqual({ '2026-11-16': 'tx' });
  });
});

describe('linkedDays is server managed', () => {
  const body = {
    name: 'Rent',
    amount: 1,
    currency: 'UZS',
    icon: 'x',
    recurrence: 'once',
    paid: { [day]: 'tx' },
    linkedDays: [day],
  };
  it('is stripped from create and update bodies', () => {
    const created: any = plannedExpenseCreateSchema.parse(body);
    expect(created.linkedDays).toBeUndefined();
    expect(created.paid).toBeUndefined();
    const updated: any = plannedExpenseUpdateSchema.parse({ name: 'a', linkedDays: [day] });
    expect(updated).toEqual({ name: 'a' });
  });
});

describe('link/unlink validation', () => {
  it('uses settle day-key validation and accepts transaction ids of 1..128 characters', () => {
    for (const transactionId of ['a', 'a'.repeat(128)])
      expect(plannedExpenseLinkSchema.safeParse({ day, transactionId }).success).toBe(true);
    for (const transactionId of ['', 'a'.repeat(129), undefined, 42])
      expect(plannedExpenseLinkSchema.safeParse({ day, transactionId }).success).toBe(false);
    expect(plannedExpenseUnlinkSchema.safeParse({ day }).success).toBe(false);
    for (const transactionId of ['', 'a'.repeat(129)])
      expect(plannedExpenseUnlinkSchema.safeParse({ day, transactionId }).success).toBe(false);
    for (const schema of [plannedExpenseLinkSchema, plannedExpenseUnlinkSchema]) {
      for (const invalidDay of [undefined, '14-11-2026', 'x'])
        expect(schema.safeParse({ day: invalidDay, transactionId: 'tx' }).success).toBe(false);
      expect(schema.safeParse({ day, transactionId: 'tx' }).success).toBe(true);
    }
  });
});
