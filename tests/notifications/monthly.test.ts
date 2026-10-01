import { describe, expect, it } from 'vitest';
import { collectMonthly } from '../../src/notifications/collectors/monthly';
import type { Budget, Category, Transaction } from '../../src/domain/types';

const category = { id: 'food', name: 'Food', icon: '🍔', color: '', type: 'expense', userId: 'u', createdAt: 0 } as Category;
const transaction = (patch: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(), amount: 100, currency: 'UZS', type: 'expense', categoryId: 'food',
  date: Date.parse('2026-08-15T05:00:00Z'), userId: 'u', createdAt: 0, ...patch,
});

describe('monthly report', () => {
  it('calculates top categories, budget state, and subscriptions', () => {
    const result = collectMonthly({
      now: Date.parse('2026-09-01T05:00:00Z'),
      timeZone: 'Asia/Tashkent',
      transactions: [transaction({ amount: 1_200 }), transaction({ amount: 200, source: 'subscription', categoryId: '__subscription__' })],
      categories: [category],
      budgets: [{ id: 'b', categoryId: 'food', amount: 1_000, currency: 'UZS', userId: 'u', updatedAt: 0 } as Budget],
      premium: false,
      seen: {},
    });
    expect(result?.payload.topCategories[0]?.amount).toBe(1_200);
    expect(result?.payload.exceededBudgets[0]?.overBy).toBe(200);
    expect(result?.payload.subscriptionsTotal).toBe(200);
    expect(result?.payload.premiumUpsell).toBe(true);
  });
});
