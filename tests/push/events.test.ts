import { describe, expect, it } from 'vitest';
import { immediateEvents, type WriteChange } from '../../src/push/events';

const now = Date.parse('2026-11-04T05:00:00Z');
const goal = { userId: 'owner', name: 'Trip', savedAmount: 100, targetAmount: 100, currency: 'UZS' };
const premium = { isPremium: true, subscription: { tier: 'premium', premiumUntil: now + 86_400_000, source: 'atmos', lastOrderId: 'order1' } };
const change = (table: string, after: Record<string, unknown>, before?: Record<string, unknown>, id = 'entity/1') =>
  ({ key: { table, id }, before, after }) as WriteChange;

describe('immediate push events', () => {
  it('emits a goal only when it crosses its target and encodes its route', () => {
    const event = immediateEvents(change('savingsGoals', goal, { ...goal, savedAmount: 99 }), now)[0]!;
    expect(event).toMatchObject({ userId: 'owner', key: 'goal_reached:entity/1', payload: {
      kind: 'push', type: 'goal_reached', group: 'money', link: '/goals/entity%2F1',
      entityId: 'entity/1', values: { name: 'Trip', amount: 100, currency: 'UZS' }, eventAt: now,
    } });
    expect(immediateEvents(change('savingsGoals', { ...goal, savedAmount: 120 }, goal), now)).toEqual([]);
    expect(immediateEvents(change('savingsGoals', { ...goal, savedAmount: 90 }, goal), now)).toEqual([]);
    expect(immediateEvents(change('savingsGoals', { ...goal, targetAmount: 0 }), now)).toEqual([]);
  });

  it('uses stable goal dedupe keys even if a reached goal is lowered and reaches its target again', () => {
    const first = immediateEvents(change('savingsGoals', goal, { ...goal, savedAmount: 50 }), now)[0]!;
    const second = immediateEvents(change('savingsGoals', { ...goal, savedAmount: 101 }, { ...goal, savedAmount: 99 }), now + 1)[0]!;
    expect(second.key).toBe(first.key);
    expect(second.payload.eventAt).toBe(now + 1);
  });

  it('routes household goals to the household rather than their stored owner', () => {
    const event = immediateEvents(change('savingsGoals', { ...goal, householdId: 'family' }), now)[0]!;
    expect(event.householdId).toBe('family');
    expect(event).not.toHaveProperty('userId');
  });

  it('notifies previous household members about each new member, not household creation or unchanged membership', () => {
    const before = { memberIds: ['owner'], members: [{ userId: 'owner', name: 'Owner' }] };
    const after = { memberIds: ['owner', 'partner'], members: [...before.members, { userId: 'partner', name: 'Ali' }] };
    const event = immediateEvents(change('households', after, before, 'family'), now)[0]!;
    expect(event).toMatchObject({ userId: 'owner', key: 'family_joined:family:partner:owner',
      payload: { type: 'family_joined', group: 'family', link: '/family', values: { name: 'Ali' } } });
    expect(immediateEvents(change('households', after), now)).toEqual([]);
    expect(immediateEvents(change('households', after, after), now)).toEqual([]);
    expect(immediateEvents(change('households', before, after), now)).toEqual([]);
  });

  it('emits household expense only on creation and excludes the actor from recipients', () => {
    const expense = { userId: 'owner', scope: 'household', householdId: 'family', type: 'expense',
      amount: 50, currency: 'USD', createdBy: 'partner', createdByName: 'Ali', categoryName: 'Food' };
    expect(immediateEvents(change('transactions', expense), now)[0]).toMatchObject({ householdId: 'family', excludeUid: 'partner',
      key: 'family_expense:entity/1', payload: { type: 'family_expense', group: 'familyExpenses', link: '/family',
        values: { name: 'Ali', amount: 50, currency: 'USD', category: 'Food' } } });
    for (const variant of [{ ...expense, scope: 'personal' }, { ...expense, type: 'income' },
      { ...expense, source: 'transfer' }, { ...expense, source: 'return' }, { ...expense, source: 'subscription' }]) {
      expect(immediateEvents(change('transactions', variant), now)).toEqual([]);
    }
    expect(immediateEvents(change('transactions', { ...expense, amount: 60 }, expense), now)).toEqual([]);
  });

  it.each(['atmos', 'apple'])('emits activation for a new paid %s entitlement or renewal', source => {
    const after = { ...premium, subscription: { ...premium.subscription, source } };
    const event = immediateEvents(change('profiles', after, { isPremium: false }, 'owner'), now)[0]!;
    expect(event).toMatchObject({ userId: 'owner', key: 'premium_activated:owner:order1',
      payload: { type: 'premium_activated', group: 'premium', link: '/premium', values: { date: after.subscription.premiumUntil } } });
    expect(immediateEvents(change('profiles', after, after), now)).toEqual([]);
    const renewal = immediateEvents(change('profiles', { ...after, subscription: { ...after.subscription, lastOrderId: 'order2', premiumUntil: now + 2 * 86_400_000 } }, after, 'owner'), now)[0]!;
    expect(renewal.key).toBe('premium_activated:owner:order2');
  });

  it('uses expiry for legacy payment dedupe and skips trials, nonpaid sources, disabled or expired entitlements', () => {
    const legacy = { ...premium, subscription: { ...premium.subscription, lastOrderId: undefined } };
    expect(immediateEvents(change('profiles', legacy, undefined, 'owner'), now)[0]?.key)
      .toBe(`premium_activated:owner:${legacy.subscription.premiumUntil}`);
    for (const after of [{ ...premium, isPremium: false },
      { ...premium, subscription: { ...premium.subscription, isTrial: true } },
      { ...premium, subscription: { ...premium.subscription, source: 'none' } },
      { ...premium, subscription: { ...premium.subscription, premiumUntil: now } }]) {
      expect(immediateEvents(change('profiles', after), now)).toEqual([]);
    }
  });

  it('does not invent Apple failure events or events from unrelated documents', () => {
    expect(immediateEvents(change('profiles', { isPremium: false, subscription: { source: 'apple' } }), now)).toEqual([]);
    expect(immediateEvents(change('cards', { userId: 'owner', balance: 100 }), now)).toEqual([]);
  });
});
