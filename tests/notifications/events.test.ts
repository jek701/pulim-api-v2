import { describe, expect, it } from 'vitest';
import { collectEvents } from '../../src/notifications/collectors/events';
import type { Card, Debt, Deposit, SavingsGoal, Subscription } from '../../src/domain/types';

const now = Date.parse('2026-09-02T05:00:00Z');
const zone = 'Asia/Tashkent';
const base = { now, timeZone: zone, seen: {}, subscriptions: [], debts: [], cards: [], deposits: [], goals: [] };

describe('event collector', () => {
  it('returns no events for an empty day', () => {
    expect(collectEvents(base)).toEqual({ events: [], stateKeys: [] });
  });

  it('includes a subscription tomorrow but not the day after', () => {
    const subscription = (days: number) => ({
      id: `s${days}`, name: 'Music', icon: '🎵', amount: 10, currency: 'UZS', cycle: 'monthly',
      nextBillingDate: now + days * 86_400_000, isActive: true, userId: 'u', createdAt: now,
    }) as Subscription;
    const result = collectEvents({ ...base, subscriptions: [subscription(1), subscription(2)] });
    expect(result.events.map((event) => event.id)).toEqual(['s1']);
  });

  it('includes an overdue debt once per ISO week', () => {
    const debt = {
      id: 'd1', direction: 'i_owe', person: 'A', amount: 100, paidAmount: 20, currency: 'UZS',
      dueDate: now - 86_400_000, isPaid: false, userId: 'u', createdAt: now,
    } as Debt;
    const first = collectEvents({ ...base, debts: [debt] });
    expect(first.events[0]?.kind).toBe('debt');
    expect(collectEvents({ ...base, debts: [debt], seen: { [first.stateKeys[0]!]: now } }).events).toHaveLength(0);
  });

  it('collects deposit horizons and ignores unrelated cards/goals', () => {
    const deposit = (id: string, days: number) => ({
      id, userId: 'u', bank: 'Bank', amount: 100, currency: 'UZS', interestRate: 10,
      startDate: now - 10_000, endDate: now + days * 86_400_000, capitalization: 'monthly',
      showInterest: false, interestPaidOut: 0, isReplenishable: true, isClosed: false, createdAt: now,
    }) as Deposit;
    const result = collectEvents({
      ...base,
      deposits: [deposit('seven', 7), deposit('one', 1)],
      cards: [] as Card[],
      goals: [] as SavingsGoal[],
    });
    expect(result.events.map((event) => event.id)).toEqual(['seven', 'one']);
  });
});
