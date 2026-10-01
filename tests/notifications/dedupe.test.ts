import { describe, expect, it } from 'vitest';
import { collectEvents } from '../../src/notifications/collectors/events';
import type { Debt } from '../../src/domain/types';

const zone = 'Asia/Tashkent';
const baseDebt = {
  id: 'debt', direction: 'i_owe', person: 'A', amount: 100, paidAmount: 0,
  currency: 'UZS', isPaid: false, userId: 'u', createdAt: 0,
} as Debt;

function collect(now: number, debt: Debt, seen: Record<string, number> = {}) {
  return collectEvents({ now, timeZone: zone, seen, debts: [debt], subscriptions: [], cards: [], deposits: [], goals: [] });
}

describe('notification reason keys', () => {
  it('does not repeat the three-day debt horizon the next day', () => {
    const now = Date.parse('2026-09-02T05:00:00Z');
    const debt = { ...baseDebt, dueDate: now + 3 * 86_400_000 };
    const first = collect(now, debt);
    expect(first.stateKeys).toEqual(['debt:debt:3d']);
    expect(collect(now + 86_400_000, debt, { [first.stateKeys[0]!]: now }).events).toHaveLength(0);
  });

  it('does not burn a key until delivery records it', () => {
    const now = Date.parse('2026-09-02T05:00:00Z');
    const debt = { ...baseDebt, dueDate: now };
    expect(collect(now, debt).stateKeys).toEqual(collect(now, debt).stateKeys);
  });
});
