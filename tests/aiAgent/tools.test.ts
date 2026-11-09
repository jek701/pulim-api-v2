import { describe, it, expect } from 'vitest';
import { executeTool, toolDefinitions } from '../../src/ai/agent/tools';
import { createFixtureDataSource } from '../../src/ai/agent/fixtureDataSource';
import { emptyFilters } from '../../src/ai/agent/stats';
import { aiAgentUser, fixtureNow } from '../fixtures/aiAgentUser';
const ds = createFixtureDataSource(aiAgentUser),
  filters = emptyFilters('2026-10-01', '2026-10-31');
const call = (tool: string, args: unknown) => executeTool(tool, args, ds, fixtureNow);
describe('strict tools', () => {
  it('requires every field and rejects extras recursively', () => {
    const check = (schema: any) => {
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties));
        Object.values(schema.properties).forEach(check);
      }
    };
    toolDefinitions.forEach((t) => {
      expect(t.strict).toBe(true);
      check(t.parameters);
    });
    expect(toolDefinitions.find((t) => t.name === 'get_spending_stats')?.description).toMatch(
      /meaningful time/,
    );
  });
  it.each([
    ['calculate', {}],
    ['calculate', { expression: '1', uid: 'other' }],
    ['get_spending_stats', { filters, group_by: 'none', top_n: 63 }],
    [
      'find_transactions',
      { filters: { ...filters, date_from: '2026-02-30' }, sort: 'date_desc', limit: 1 },
    ],
    ['get_transactions_digest', { filters: { ...filters, uid: 'other' }, limit: 5 }],
    ['get_budgets_status', { month: '2026-13' }],
    ['get_upcoming', { days_ahead: 91 }],
    ['unknown', {}],
    ['calculate', '{'],
  ])('returns error rather than throwing for %s', async (tool, args) =>
    expect(await call(tool as string, args)).toHaveProperty('error'),
  );
  it('validates dates/ranges before I/O', async () => {
    expect(
      await call('find_transactions', {
        filters: { ...filters, date_from: '2020-01-01' },
        sort: 'date_desc',
        limit: 1,
      }),
    ).toHaveProperty('error');
    expect(
      await call('find_transactions', {
        filters: { ...filters, hour_from: 20, hour_to: 10 },
        sort: 'date_desc',
        limit: 1,
      }),
    ).toHaveProperty('error');
  });
  it('returns stats, search, digest, budget and upcoming shapes', async () => {
    expect(
      await call('get_spending_stats', { filters, group_by: 'month', top_n: null }),
    ).toMatchObject({
      period: { matching_days: 31 },
      totals: { sum: expect.any(Number) },
      notes: expect.any(Array),
    });
    const found = await call('find_transactions', { filters, sort: 'amount_desc', limit: 2 });
    expect(found.total_matching).toBeGreaterThan(2);
    expect(found.rows).toHaveLength(2);
    expect(found.rows[0]).toMatchObject({
      date: expect.stringMatching(/^2026-10-/),
      amount_uzs: expect.any(Number),
      category: expect.any(String),
      comment: expect.any(String),
    });
    const digest = await call('get_transactions_digest', {
      filters: { ...filters, kind: null },
      limit: 2,
    });
    expect(digest.truncated).toBe(true);
    expect(digest.lines.split('\n')).toHaveLength(2);
    expect(digest.lines).toContain('|exp|');
    const budgets = await call('get_budgets_status', { month: null });
    expect(budgets.income_target).toMatchObject({ limit: 14000000, spent: 0 });
    expect(budgets.budgets).toHaveLength(2);
    expect(await call('get_upcoming', { days_ahead: 14 })).toMatchObject({
      totals: { expense_uzs: 5050000, income_uzs: 1300000 },
      unconverted_count: 0,
    });
    expect(await call('calculate', { expression: '(100-20)/4' })).toEqual({ result: 20 });
  });
  it('expands recurrence in Tashkent and omits paid/skipped items', async () => {
    const custom = createFixtureDataSource({
      plannedExpenses: [
        {
          ...aiAgentUser.plannedExpenses[0],
          recurrence: 'daily',
          skipped: ['2026-11-09'],
          paid: { '2026-11-10': 'paid' },
        },
      ],
    });
    const result = await executeTool('get_upcoming', { days_ahead: 3 }, custom, fixtureNow);
    expect(result.rows.map((r: any) => r.date)).toEqual(['2026-11-11']);
  });
});
