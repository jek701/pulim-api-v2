import { describe, expect, it } from 'vitest';
import { collectWeekly } from '../../src/notifications/collectors/weekly';
import type { Category, Transaction } from '../../src/domain/types';
import { emptyNotificationState } from '../../src/notifications/state.repository';

const now = Date.parse('2026-09-07T05:00:00Z');
const category = { id: 'food', name: 'Food', icon: '🍔', color: '', type: 'expense', userId: 'u', createdAt: 0 } as Category;
const tx = (patch: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(), amount: 100, currency: 'UZS', type: 'expense', categoryId: 'food',
  date: Date.parse('2026-09-02T05:00:00Z'), userId: 'u', createdAt: 0, ...patch,
});

describe('weekly report', () => {
  it('excludes transfers, nets refunds, and counts unconverted rows', () => {
    const result = collectWeekly({
      now, timeZone: 'Asia/Tashkent', categories: [category], state: emptyNotificationState('u'),
      transactions: [
        tx({ amount: 500 }),
        tx({ amount: 50, type: 'income', source: 'return' }),
        tx({ amount: 999, source: 'transfer' }),
        tx({ amount: 10, currency: 'USD' }),
      ],
    });
    expect(result?.payload.expense).toBe(450);
    expect(result?.payload.operationCount).toBe(3);
    expect(result?.payload.unconvertedCount).toBe(1);
  });

  it('stays silent after two consecutive empty reports', () => {
    const state = { ...emptyNotificationState('u'), weeklyEmptyStreak: 2 };
    expect(collectWeekly({ now, timeZone: 'Asia/Tashkent', categories: [], transactions: [], state })).toBeNull();
  });
});
