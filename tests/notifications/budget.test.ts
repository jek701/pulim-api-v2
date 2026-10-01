import { describe, expect, it } from 'vitest';
import { collectBudgetAlerts } from '../../src/notifications/collectors/budget';
import { emptyNotificationState } from '../../src/notifications/state.repository';
import type { Budget, Category, Transaction } from '../../src/domain/types';

const now = Date.parse('2026-09-10T05:00:00Z');
const category = { id: 'food', name: 'Food', icon: '🍔', color: '', type: 'expense', userId: 'u', createdAt: 0 } as Category;
const budget = { id: 'b', categoryId: 'food', amount: 1_000, currency: 'UZS', userId: 'u', updatedAt: 0 } as Budget;
const transaction = (amount: number): Transaction => ({
  id: String(amount), amount, currency: 'UZS', type: 'expense', categoryId: 'food', date: now, userId: 'u', createdAt: 0,
});

function collect(amount: number, seen: Record<string, number> = {}) {
  return collectBudgetAlerts({
    now, timeZone: 'Asia/Tashkent', transactions: [transaction(amount)], budgets: [budget],
    categories: [category], subcategories: [], state: { ...emptyNotificationState('u'), seen }, premium: false,
  });
}

describe('budget thresholds', () => {
  it('triggers at exactly 80 percent but not below', () => {
    expect(collect(799)).toHaveLength(0);
    expect(collect(800)[0]?.payload.threshold).toBe(80);
  });

  it('uses the 100 percent event as the stronger threshold', () => {
    const alert = collect(1_000)[0]!;
    expect(alert.payload.threshold).toBe(100);
    expect(alert.stateKeys).toHaveLength(2);
  });

  it('does not repeat a sent threshold in the same month', () => {
    const key = collect(800)[0]!.dedupeKey;
    expect(collect(900, { [key]: now })).toHaveLength(0);
  });
});
