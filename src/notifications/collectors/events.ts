import type { Card, Debt, Deposit, SavingsGoal, Subscription } from '../../domain/types';
import { calcDebtTotal } from '../../domain/debt';
import { calcRemainingInterest } from '../../domain/deposit';
import { addLocalDays, calendarDayDifference, calendarParts, dateKey, isoWeekKey } from '../schedule';
import type { DailyEvent } from '../types';

export interface EventCollection {
  events: DailyEvent[];
  stateKeys: string[];
}

function pushUnlessSeen(
  result: EventCollection,
  seen: Record<string, number>,
  key: string,
  event: DailyEvent,
): void {
  if (seen[key]) return;
  result.events.push(event);
  result.stateKeys.push(key);
}

export function collectEvents(input: {
  now: number;
  timeZone: string;
  seen: Record<string, number>;
  subscriptions: Subscription[];
  debts: Debt[];
  cards: Card[];
  deposits: Deposit[];
  goals: SavingsGoal[];
}): EventCollection {
  const result: EventCollection = { events: [], stateKeys: [] };
  const { now, timeZone, seen } = input;

  for (const subscription of input.subscriptions) {
    const difference = calendarDayDifference(subscription.nextBillingDate, now, timeZone);
    if (!subscription.isActive || (difference !== 0 && difference !== 1)) continue;
    const key = `sub:${subscription.id}:${dateKey(subscription.nextBillingDate, timeZone)}`;
    pushUnlessSeen(result, seen, key, {
      kind: 'subscription',
      id: subscription.id,
      name: subscription.name,
      icon: subscription.icon,
      amount: subscription.amount,
      currency: subscription.currency,
      nextBillingDate: subscription.nextBillingDate,
      due: difference === 0 ? 'today' : 'tomorrow',
    });
  }

  for (const debt of input.debts) {
    if (debt.isPaid || typeof debt.dueDate !== 'number') continue;
    const difference = calendarDayDifference(debt.dueDate, now, timeZone);
    let key: string | null = null;
    let due: 'in_3_days' | 'today' | 'overdue' | null = null;
    if (difference === 3) {
      key = `debt:${debt.id}:3d`;
      due = 'in_3_days';
    } else if (difference === 0) {
      key = `debt:${debt.id}:due`;
      due = 'today';
    } else if (difference < 0) {
      key = `debt:${debt.id}:overdue:${isoWeekKey(now, timeZone)}`;
      due = 'overdue';
    }
    if (!key || !due) continue;
    pushUnlessSeen(result, seen, key, {
      kind: 'debt',
      id: debt.id,
      person: debt.person,
      direction: debt.direction,
      remaining: Math.max(0, calcDebtTotal(debt.amount, debt.commission) - Number(debt.paidAmount ?? 0)),
      currency: debt.currency,
      due,
    });
  }

  const today = calendarParts(now, timeZone);
  const inTwoDays = calendarParts(addLocalDays(now, 2, timeZone), timeZone);
  for (const card of input.cards) {
    if (card.cardType !== 'credit' || !card.dueDay || card.balance <= 0) continue;
    const due = card.dueDay === today.day ? 'today' : card.dueDay === inTwoDays.day ? 'in_2_days' : null;
    if (!due) continue;
    const key = `card:${card.id}:${dateKey(now, timeZone).slice(0, 7)}`;
    pushUnlessSeen(result, seen, key, {
      kind: 'credit_card', id: card.id, name: card.name, balance: card.balance, currency: card.currency, due,
    });
  }

  for (const deposit of input.deposits) {
    if (deposit.isClosed) continue;
    const difference = calendarDayDifference(deposit.endDate, now, timeZone);
    if (difference === 7 || difference === 1) {
      const horizon = difference === 7 ? '7d' : '1d';
      const key = `deposit:${deposit.id}:${horizon}`;
      pushUnlessSeen(result, seen, key, {
        kind: 'deposit',
        id: deposit.id,
        bank: deposit.bank,
        amount: deposit.amount,
        currency: deposit.currency,
        event: difference === 7 ? 'ends_7d' : 'ends_1d',
      });
    } else if (deposit.showInterest) {
      const interest = calcRemainingInterest(deposit, now);
      if (interest > 0) {
        const key = `deposit:${deposit.id}:interest:${dateKey(now, timeZone).slice(0, 7)}`;
        pushUnlessSeen(result, seen, key, {
          kind: 'deposit', id: deposit.id, bank: deposit.bank, amount: interest, currency: deposit.currency, event: 'interest',
        });
      }
    }
  }

  for (const goal of input.goals) {
    if (goal.savedAmount >= goal.targetAmount
      || calendarDayDifference(goal.deadline, now, timeZone) !== 7) continue;
    const key = `goal:${goal.id}:7d`;
    pushUnlessSeen(result, seen, key, {
      kind: 'goal',
      id: goal.id,
      name: goal.name,
      remaining: Math.max(0, goal.targetAmount - goal.savedAmount),
      currency: goal.currency,
    });
  }

  return result;
}
