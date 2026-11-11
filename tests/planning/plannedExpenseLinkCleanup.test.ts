import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  patches: [] as Array<[any, any]>,
  plainReads: vi.fn(),
  lockedKeys: [] as string[],
  transactions: vi.fn(),
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
    // chained filters (linked refunds) keep the last one only; fine for these tests
  }),
  patchValue: { increment: (n: number) => ({ inc: n }) },
  readDocument: async (key: any) => {
    state.plainReads(key);
    return state.select(key);
  },
  runSqlTransaction: async (work: any) => {
    state.transactions();
    const removed: string[] = [];
    let wrote = false;
    const result = await work({
      read: async (key: any) => {
        if (wrote) throw new Error('Read after write');
        if (key.field) return key.table === 'transactions' ? { rows: [] } : state.select(key);
        state.lockedKeys.push(`${key.table}/${key.id}`);
        const data = state.rows.get(`${key.table}/${key.id}`);
        return { exists: !!data, data: structuredClone(data), key };
      },
      patch: (key: any, patch: any) => {
        wrote = true;
        state.patches.push([key, patch]);
        Object.assign(state.rows.get(`${key.table}/${key.id}`), patch);
      },
      remove: (key: any) => {
        wrote = true;
        removed.push(`${key.table}/${key.id}`);
      },
    });
    removed.forEach((k) => state.rows.delete(k));
    return result;
  },
}));
vi.mock('../../src/notifications/queue.repository', () => ({
  scheduleBudgetCheck: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { deleteTransaction } from '../../src/services/transaction.service';

const day = '2026-11-14';
const plan = (id: string) => state.rows.get(`planned_expenses/${id}`);
beforeEach(() => {
  state.rows.clear();
  state.patches.length = 0;
  state.lockedKeys.length = 0;
  state.plainReads.mockClear();
  state.transactions.mockClear();
  state.rows.set('transactions/tx', { userId: 'u', type: 'expense', amount: 50 });
  state.rows.set('planned_expenses/linked', {
    userId: 'u',
    paid: { [day]: 'tx', '2026-11-20': 'keep' },
    linkedDays: [day, '2026-11-20'],
  });
});

describe('transaction delete clears plan links', () => {
  it('removes a linked entry in the same SQL transaction and makes the occurrence due again', async () => {
    await deleteTransaction('u', 'tx');
    expect(state.transactions).toHaveBeenCalledTimes(1);
    expect(state.rows.has('transactions/tx')).toBe(false);
    expect(plan('linked').paid).toEqual({ '2026-11-20': 'keep' });
    expect(plan('linked').linkedDays).toEqual(['2026-11-20']);
    // paid[day] absent again: the occurrence is due (same check as the plan consumers use)
    expect(plan('linked').paid[day]).toBeUndefined();
  });
  it('clears every plan of the user that links the transaction, ignoring other users', async () => {
    state.rows.set('planned_expenses/second', { userId: 'u', paid: { '2026-12-01': 'tx' }, linkedDays: ['2026-12-01'] });
    state.rows.set('planned_expenses/foreign', { userId: 'other', paid: { [day]: 'tx' }, linkedDays: [day] });
    await deleteTransaction('u', 'tx');
    expect(plan('second')).toMatchObject({ paid: {}, linkedDays: [] });
    expect(plan('foreign')).toEqual({ userId: 'other', paid: { [day]: 'tx' }, linkedDays: [day] });
  });
  it('leaves settle-created entries untouched and locks no plan', async () => {
    state.rows.set('planned_expenses/settled', { userId: 'u', paid: { [day]: 'tx' } });
    state.rows.set('planned_expenses/mixed', { userId: 'u', paid: { [day]: 'tx' }, linkedDays: ['2026-11-01'] });
    state.rows.delete('planned_expenses/linked');
    await deleteTransaction('u', 'tx');
    expect(plan('settled')).toEqual({ userId: 'u', paid: { [day]: 'tx' } });
    expect(plan('mixed').paid).toEqual({ [day]: 'tx' });
    expect(state.patches).toEqual([]);
    expect(state.lockedKeys).toEqual(['transactions/tx']);
  });
  it('locks only plans that need a change', async () => {
    state.rows.set('planned_expenses/other', { userId: 'u', paid: { [day]: 'zzz' }, linkedDays: [day] });
    await deleteTransaction('u', 'tx');
    expect(state.lockedKeys).toEqual(['transactions/tx', 'planned_expenses/linked']);
    expect(plan('other').paid).toEqual({ [day]: 'zzz' });
  });
});
