import { describe, expect, it } from 'vitest';
import type { Card, Debt, Deposit, SavingsGoal, Subscription, Transaction, UserProfile } from '../../src/domain/types';
import { collectScheduledPushes, refreshScheduledPush } from '../../src/push/scheduled';
import { dateKey } from '../../src/notifications/schedule';

const day = 86_400_000;
const now = Date.parse('2026-11-04T03:00:00Z'); // Wednesday, 08:00 Tashkent
const profile = { language: 'ru', createdAt: now - day, updatedAt: now } as UserProfile;
const base = { now, profile, timeZone: 'Asia/Tashkent' };
const sub = (offset = 0) => ({ id: 's', name: 'Music', amount: 1_250_000, currency: 'UZS',
  nextBillingDate: now + offset * day, isActive: true } as Subscription);
const debt = (offset: number) => ({ id: 'd', person: 'Ali', amount: 100, paidAmount: 20, currency: 'UZS',
  dueDate: now + offset * day, isPaid: false } as Debt);
const transaction = (patch: Partial<Transaction>) => ({ id: 'tx', type: 'expense', amount: 100,
  currency: 'UZS', categoryId: 'food', date: now, ...patch } as Transaction);

describe('scheduled push candidates', () => {
  it('plans today and tomorrow at local 10:00 without duplicating future subscriptions', () => {
    const candidates = collectScheduledPushes({ ...base, subscriptions: [sub(1), { ...sub(2), id: 'later' }] });
    const due = candidates.filter(candidate => candidate.type === 'subscription_due');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ runAt: Date.parse('2026-11-05T05:00:00Z'), group: 'money', link: '/subscriptions/s' });
    expect(due[0].values.amount).toBe('1\u00a0250\u00a0000 сум');
  });

  it('uses calendar days across DST rather than adding 24 hours', () => {
    const candidates = collectScheduledPushes({ profile, now: Date.parse('2026-03-07T18:00:00Z'),
      timeZone: 'America/New_York', subscriptions: [{ ...sub(), nextBillingDate: Date.parse('2026-03-08T16:00:00Z') }] });
    expect(candidates.find(candidate => candidate.type === 'subscription_due')?.runAt)
      .toBe(Date.parse('2026-03-08T14:00:00Z'));
  });

  it('collects three-day, due-day and overdue debts with weekly overdue dedupe', () => {
    const types = collectScheduledPushes({ ...base, debts: [debt(3), { ...debt(0), id: 'due' }, { ...debt(-1), id: 'late' }] })
      .filter(candidate => candidate.type.startsWith('debt_'));
    expect(types.map(candidate => candidate.type)).toEqual(['debt_3d', 'debt_due', 'debt_overdue', 'debt_overdue']);
    // Tomorrow's newly overdue due-day debt is a separate event; the existing overdue debt is deduped for the week.
    expect(types.filter(candidate => candidate.entityId === 'late')).toHaveLength(1);
    expect(types.find(candidate => candidate.type === 'debt_3d')?.values.amount).toBe('80 сум');
    const nextWeek = collectScheduledPushes({ ...base, now: now + 7 * day, debts: [debt(-1)] });
    const firstKey = collectScheduledPushes({ ...base, debts: [debt(-1)] }).find(candidate => candidate.type === 'debt_overdue')!.dedupeKey;
    expect(nextWeek.find(candidate => candidate.type === 'debt_overdue')!.dedupeKey).not.toBe(firstKey);
  });

  it('revalidates paid and deleted entities before delivery', () => {
    const candidate = collectScheduledPushes({ ...base, subscriptions: [sub()] }).find(candidate => candidate.type === 'subscription_due')!;
    expect(refreshScheduledPush(candidate, { ...base, subscriptions: [] })).toBeNull();
    expect(refreshScheduledPush(candidate, { ...base, subscriptions: [{ ...sub(), nextBillingDate: now + 30 * day }] })).toBeNull();
    const paid = collectScheduledPushes({ ...base, debts: [{ ...debt(0), isPaid: true }] });
    expect(paid.some(candidate => candidate.type.startsWith('debt_'))).toBe(false);
  });

  it('uses 21:00 only in the first 14 local days and cancels after a daily entry', () => {
    const evening = collectScheduledPushes(base).find(candidate => candidate.type === 'evening_log')!;
    expect(evening.runAt).toBe(Date.parse('2026-11-04T16:00:00Z'));
    expect(refreshScheduledPush(evening, { ...base, transactions: [transaction({})] })).toBeNull();
    expect(collectScheduledPushes({ ...base, profile: { ...profile, createdAt: now - 14 * day } })
      .some(candidate => candidate.type === 'evening_log')).toBe(false);
    expect(collectScheduledPushes({ ...base, profile: { ...profile, createdAt: undefined } })
      .some(candidate => candidate.type === 'evening_log')).toBe(false);
  });

  it('plans trial reminders at 1 and 3 days and expiry after the premium end time', () => {
    for (const days of [1, 3]) {
      const rows = collectScheduledPushes({ ...base, profile: { ...profile, subscription: { tier: 'premium', isTrial: true, premiumUntil: now + days * day } } });
      expect(rows.find(candidate => candidate.type === 'trial_ending')?.values.days).toBe(days);
    }
    const rows = collectScheduledPushes({ ...base, profile: { ...profile, subscription: { tier: 'premium', premiumUntil: now + 8 * 60 * 60_000 } } });
    expect(rows.find(candidate => candidate.type === 'premium_expired')?.runAt).toBe(Date.parse('2026-11-05T05:00:00Z'));
  });

  it('handles month-end credit due days without inventing a minimum payment', () => {
    const rows = collectScheduledPushes({ ...base, now: Date.parse('2026-11-28T03:00:00Z'),
      cards: [{ id: 'c', cardType: 'credit', dueDay: 31, balance: 100, name: 'Visa', currency: 'UZS' } as Card] });
    expect(rows.find(candidate => candidate.type === 'credit_card_due')?.values.amount).toBe('—');
    expect(rows.find(candidate => candidate.type === 'credit_card_due')?.dedupeKey).toContain('2026-11-30');
  });

  it('collects seven-day horizons and interest only on actual capitalization days', () => {
    const deposit = { id: 'deposit', bank: 'Bank', amount: 1000, currency: 'UZS', interestRate: 12,
      startDate: Date.parse('2026-10-04T03:00:00Z'), endDate: now + 7 * day,
      capitalization: 'monthly', interestPaidOut: 0, showInterest: true, isClosed: false } as Deposit;
    const goal = { id: 'g', name: 'Trip', targetAmount: 100, savedAmount: 30, currency: 'UZS', deadline: now + 7 * day } as SavingsGoal;
    const rows = collectScheduledPushes({ ...base, deposits: [deposit], goals: [goal] });
    expect(rows.filter(candidate => ['deposit_ending', 'deposit_interest', 'goal_deadline'].includes(candidate.type)))
      .toHaveLength(3);
    const later = collectScheduledPushes({ ...base, now: now + day, deposits: [deposit] });
    expect(later.some(candidate => candidate.type === 'deposit_interest')).toBe(false);
  });

  it('summarizes personal history with returns reducing expense and transfers excluded', () => {
    const monday = Date.parse('2026-11-09T03:00:00Z');
    const rows = collectScheduledPushes({ ...base, now: monday, transactions: [
      transaction({ amount: 100 }), transaction({ amount: 20, source: 'return', type: 'income' }),
      transaction({ amount: 900, source: 'transfer' }), transaction({ amount: 800, scope: 'household' }),
    ], categories: [{ id: 'food', name: 'Food', type: 'expense' } as never] });
    const summary = rows.find(candidate => candidate.type === 'weekly_summary')!;
    expect(summary.values.expense).toBe('80 сум');
    expect(summary.values.category).toBe('Food');
    expect(rows.some(candidate => candidate.type === 'evening_log' && dateKey(candidate.runAt, base.timeZone) === '2026-11-09')).toBe(false);
  });

  it('prioritizes the monthly report when the first of the month is Monday', () => {
    const rows = collectScheduledPushes({ ...base, now: Date.parse('2027-02-01T03:00:00Z') });
    expect(rows.filter(candidate => candidate.group === 'habit').map(candidate => candidate.type)).toEqual(['monthly_summary']);
    expect(rows.find(candidate => candidate.type === 'monthly_summary')?.values.month).toBe('января');
  });
});
