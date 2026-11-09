import { describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (collection: string) => ({ collection, filters: [] }),
  filterQuery: (query: any, field: string, op: string, value: unknown) => ({
    ...query,
    filters: [...query.filters, { field, op, value }],
  }),
  documentKey: (query: any, id: string) => ({ ...query, id }),
  readDocument: db.read,
}));
import { createDbDataSource } from '../../src/ai/agent/dataSource';
import { dayMs, DAY } from '../../src/ai/agent/time';
describe('run-scoped DB source with fake document reads', () => {
  it('shares one widest-range query between parallel tools and restricts owner/bounds', async () => {
    db.read.mockResolvedValue({
      rows: [
        { id: 'sep', data: { date: dayMs('2026-09-10') } },
        { id: 'oct', data: { date: dayMs('2026-10-10') } },
        { id: 'family', data: { date: dayMs('2026-10-11'), scope: 'household' } },
      ],
    });
    const ds = createDbDataSource('owner', dayMs('2026-11-09'));
    const [sept, oct] = await Promise.all([
      ds.transactions(dayMs('2026-09-01'), dayMs('2026-09-30') + DAY - 1),
      ds.transactions(dayMs('2026-10-01'), dayMs('2026-10-31') + DAY - 1),
    ]);
    expect(sept.map((t) => t.id)).toEqual(['sep']);
    expect(oct.map((t) => t.id)).toEqual(['oct']);
    expect(db.read).toHaveBeenCalledOnce();
    expect(db.read.mock.calls[0][0]).toEqual({
      collection: 'transactions',
      filters: [
        { field: 'userId', op: '==', value: 'owner' },
        { field: 'date', op: '>=', value: dayMs('2023-11-09') },
      ],
    });
  });
  it('memoizes collections per run, uses real collection names, never shares across users', async () => {
    db.read.mockReset().mockResolvedValue({ rows: [], data: null });
    const ds = createDbDataSource('owner');
    await Promise.all([
      ds.categories(),
      ds.categories(),
      ds.subcategories(),
      ds.accounts(),
      ds.budgets(),
      ds.subscriptions(),
      ds.plannedExpenses(),
      ds.debts(),
      ds.savingsGoals(),
      ds.profile(),
    ]);
    expect(db.read).toHaveBeenCalledTimes(9);
    expect(db.read.mock.calls.map((c) => c[0].collection)).toEqual(
      expect.arrayContaining(['cards', 'planned_expenses', 'savingsGoals', 'profiles']),
    );
    await createDbDataSource('other').categories();
    expect(db.read).toHaveBeenCalledTimes(10);
  });
});
