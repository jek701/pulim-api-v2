import { describe, it, expect } from 'vitest';
import type { Transaction } from '../../src/domain/types';
import {
  GROUPS,
  emptyFilters,
  spendingStats,
  selectTransactions,
  merchant,
} from '../../src/ai/agent/stats';
import { dayMs, dayKey, weekKey, validateRange } from '../../src/ai/agent/time';
const row = (key: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id: key + amount,
  userId: 'u',
  createdAt: 0,
  date: dayMs(key) + 12 * 3600000,
  type: 'expense',
  amount,
  currency: 'UZS',
  categoryId: 'food',
  cardId: 'a',
  ...extra,
});
const lookup: any = {
  categories: [
    { id: 'food', name: 'Продукты' },
    { id: 'cafe', name: 'Кафе' },
  ],
  subcategories: [{ id: 'coffee', name: 'Кофе', categoryId: 'cafe' }],
  accounts: [{ id: 'a', name: 'Карта' }],
};
describe('Tashkent personal statistics', () => {
  it('uses all 44 weekdays in Sept+Oct, not just spend days (hand computed)', () => {
    const txs = [
      row('2026-09-01', 44000),
      row('2026-09-02', 88000, { categoryId: 'cafe' }),
      row('2026-10-01', 88000),
      row('2026-10-03', 900000),
      row('2026-10-02', 99999, { categoryId: 'taxi' }),
    ];
    const f = {
      ...emptyFilters('2026-09-01', '2026-10-31'),
      category_ids: ['food', 'cafe'],
      weekdays: [1, 2, 3, 4, 5],
    };
    const result = spendingStats(txs, f, 'month');
    expect(result.period).toEqual({
      from: '2026-09-01',
      to: '2026-10-31',
      calendar_days: 61,
      matching_days: 44,
      days_with_transactions: 3,
    });
    expect(result.totals).toMatchObject({
      sum: 220000,
      count: 3,
      avg_per_matching_day: 5000,
      median_transaction: 88000,
    });
    expect(result.groups.map((g) => [g.key, g.matching_days, g.avg_per_matching_day])).toEqual([
      ['2026-09', 22, 6000],
      ['2026-10', 22, 4000],
    ]);
  });
  it('respects both UTC boundary directions, ISO week/year and leap dates', () => {
    const txs = [
      row('2026-10-01', 1, { date: Date.parse('2026-10-01T23:30:00+05:00') }),
      row('2026-10-01', 2, { date: Date.parse('2026-10-02T00:30:00+05:00') }),
    ];
    expect(spendingStats(txs, emptyFilters('2026-10-01', '2026-10-01'), 'day').totals.sum).toBe(1);
    expect(dayKey(Date.parse('2026-09-30T20:00:00Z'))).toBe('2026-10-01');
    expect(weekKey(dayMs('2027-01-01'))).toBe('2026-W53');
    expect(() => dayMs('2026-02-29')).toThrow();
    expect(() => validateRange('2022-01-01', '2026-01-01', dayMs('2026-11-09'))).toThrow();
  });
  it('excludes transfers/household and subtracts linked return once, on its own date', () => {
    const txs = [
      row('2026-09-01', 100, { id: 'purchase', returnedAmount: 30 }),
      row('2026-10-02', 30, { source: 'return', type: 'income', linkedTransactionId: 'purchase' }),
      row('2026-10-02', 500, { source: 'transfer' }),
      row('2026-10-02', 500, { scope: 'household' }),
      row('2026-10-02', 20, { type: 'income' }),
    ];
    expect(spendingStats(txs, emptyFilters('2026-09-01', '2026-09-30'), 'none').totals.sum).toBe(
      100,
    );
    expect(spendingStats(txs, emptyFilters('2026-10-01', '2026-10-31'), 'none').totals.sum).toBe(
      -30,
    );
    expect(spendingStats(txs, emptyFilters('2026-09-01', '2026-10-31'), 'none').totals.sum).toBe(
      70,
    );
    expect(
      spendingStats(txs, emptyFilters('2026-10-01', '2026-10-31', 'income'), 'none').totals.sum,
    ).toBe(20);
  });
  it('normalizes saved FX and counts missing/non-finite conversions', () => {
    const txs = [
      row('2026-10-01', 100),
      row('2026-10-01', 10, { currency: 'USD', baseAmount: 130000 }),
      row('2026-10-01', 10, { currency: 'USD' }),
      row('2026-10-01', 10, { currency: 'USD', baseAmount: Infinity }),
    ];
    const stats = spendingStats(txs, emptyFilters('2026-10-01', '2026-10-31'), 'none');
    expect(stats.totals.sum).toBe(130100);
    expect(stats.totals.count).toBe(2);
    expect(stats.unconverted_count).toBe(2);
  });
  it('category includes children; subcategory and exclusion filters work', () => {
    const txs = [
      row('2026-10-01', 10, { categoryId: 'cafe', subcategoryId: 'coffee' }),
      row('2026-10-01', 20, { categoryId: 'cafe', subcategoryId: 'fastfood' }),
    ];
    const f = emptyFilters('2026-10-01', '2026-10-31');
    expect(spendingStats(txs, { ...f, category_ids: ['cafe'] }, 'none').totals.sum).toBe(30);
    expect(spendingStats(txs, { ...f, category_ids: ['coffee'] }, 'none').totals.sum).toBe(10);
    expect(spendingStats(txs, { ...f, exclude_category_ids: ['coffee'] }, 'none').totals.sum).toBe(
      20,
    );
  });
  it.each(GROUPS)('produces consistent %s groups, labels and calendar denominators', (group) => {
    const txs = [
      row('2026-10-01', 100, { categoryId: 'cafe', subcategoryId: 'coffee', comment: 'EVOS' }),
      row('2026-10-02', 200, { categoryId: 'food', comment: 'Safia' }),
    ];
    const stats = spendingStats(txs, emptyFilters('2026-10-01', '2026-10-31'), group, 62, lookup);
    expect(stats.totals.sum).toBe(300);
    if (group === 'none') expect(stats.groups).toEqual([]);
    else expect(stats.groups.reduce((n, g) => n + g.sum, 0)).toBe(300);
    if (group === 'category')
      expect(stats.groups.map((g) => g.label)).toEqual(['Продукты', 'Кафе']);
    if (group === 'weekday') expect(stats.groups.map((g) => g.matching_days)).toEqual([5, 5]);
    if (group === 'hour') expect(stats.groups[0].matching_days).toBe(31);
  });
  it('truncates time groups chronologically and categories by descending sum', () => {
    const txs = [row('2026-10-01', 10), row('2026-10-02', 200, { categoryId: 'cafe' })];
    const f = emptyFilters('2026-10-01', '2026-10-31');
    expect(spendingStats(txs, f, 'day', 1)).toMatchObject({
      truncated: true,
      groups: [{ key: '2026-10-01', sum: 10 }],
    });
    expect(spendingStats(txs, f, 'category', 1).groups[0].key).toBe('cafe');
  });
  it('handles zero days, text/account/hour/amount filters and merchant fallback', () => {
    const tx = row('2026-10-01', 100, { comment: 'Lunch EVOS', sourceLabel: 'Merchant' });
    const f = {
      ...emptyFilters('2026-10-01', '2026-10-31'),
      text_query: 'evos',
      account_ids: ['a'],
      hour_from: 12,
      hour_to: 13,
      min_amount_uzs: 99,
      max_amount_uzs: 101,
    };
    expect(selectTransactions([tx], f)).toEqual([tx]);
    expect(selectTransactions([tx], { ...f, exclude_text: 'lunch' })).toEqual([]);
    expect(spendingStats([], { ...f, weekdays: [] }, 'none').totals.avg_per_matching_day).toBe(0);
    expect(merchant({ ...tx, capture: { merchant: { name: 'Shop' } } as any })).toBe('Shop');
    expect(merchant({ ...tx, sourceLabel: '', comment: '  TEST  ' })).toBe('test');
  });
});
