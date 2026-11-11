import type { PlanContext, PlanSetup } from '../../src/plans/schemas';
export const group = (id = 'g1', extra = {}) => ({
  id,
  type: 'expense' as const,
  category: 'Housing',
  names: ['Rent'],
  count: 5,
  medianAmount: 300,
  minAmount: 300,
  maxAmount: 300,
  currency: 'UZS',
  dates: ['2026-11-01'],
  cadence: 'monthly' as const,
  confidence: 'high' as const,
  ...extra,
});
export const setup: PlanSetup = {
  language: 'ru',
  today: '2026-11-11',
  groups: [group()],
  existing: [],
};
export const context = (closes = [100, 80, 150]): PlanContext => ({
  today: '2026-01-30',
  currency: 'UZS',
  balance: closes[0],
  everydayPerDay: 10,
  headline: { mode: 'date', day: '2026-01-31', value: 80 },
  days: closes.map((close, i) => ({
    d: new Date(Date.UTC(2026, 0, 30 + i)).toISOString().slice(0, 10),
    close,
  })),
  items: [],
  nextIncome: null,
  pendingIncomes: 0,
});
