import { describe, expect, it } from 'vitest';
import {
  plannedExpenseCreateSchema,
  plannedExpenseSettleSchema,
  plannedExpenseUpdateSchema,
} from '../../src/domain/schemas';
import { MAX_SKIPPED_DAYS, planKeyCutoff, prunePlanDayKeys } from '../../src/domain/plannedPaid';

const base = { name: 'Rent', amount: 100, currency: 'UZS', icon: 'x', recurrence: 'monthly' };

describe('planned expense schemas', () => {
  it('accepts accountId and skipped, strips paid', () => {
    const parsed = plannedExpenseCreateSchema.parse({
      ...base,
      accountId: 'acc1',
      skipped: ['2026-11-14'],
      paid: { '2026-11-14': 'tx' },
    });
    expect(parsed.accountId).toBe('acc1');
    expect(parsed.skipped).toEqual(['2026-11-14']);
    expect('paid' in parsed).toBe(false);
    expect('paid' in plannedExpenseUpdateSchema.parse({ paid: { a: 'b' }, skipped: [] })).toBe(false);
  });
  it('validates skipped day keys and the 400 cap', () => {
    expect(plannedExpenseUpdateSchema.safeParse({ skipped: ['14-11-2026'] }).success).toBe(false);
    const ok = Array.from({ length: MAX_SKIPPED_DAYS }, () => '2026-11-14');
    expect(plannedExpenseUpdateSchema.safeParse({ skipped: ok }).success).toBe(true);
    expect(plannedExpenseUpdateSchema.safeParse({ skipped: [...ok, '2026-11-14'] }).success).toBe(false);
  });
  it('settle schema', () => {
    expect(plannedExpenseSettleSchema.safeParse({ day: '2026-11-14' }).success).toBe(true);
    expect(
      plannedExpenseSettleSchema.safeParse({
        day: '2026-11-14', accountId: 'a', categoryId: 'c', amount: 5, transactionId: 'abcdefgh', date: 1,
      }).success,
    ).toBe(true);
    expect(plannedExpenseSettleSchema.safeParse({}).success).toBe(false);
    expect(plannedExpenseSettleSchema.safeParse({ day: 'x' }).success).toBe(false);
    expect(plannedExpenseSettleSchema.safeParse({ day: '2026-11-14', amount: 0 }).success).toBe(false);
    expect(plannedExpenseSettleSchema.safeParse({ day: '2026-11-14', transactionId: 'short' }).success).toBe(false);
  });
});

describe('prunePlanDayKeys', () => {
  const now = Date.UTC(2026, 10, 14);
  it('drops keys older than 60 days', () => {
    expect(planKeyCutoff(now)).toBe('2026-09-15');
    const out = prunePlanDayKeys(
      { '2026-09-14': 'old', '2026-09-15': 'edge', '2026-11-14': 'new' },
      ['2026-01-01', '2026-10-01'],
      now,
    );
    expect(out.paid).toEqual({ '2026-09-15': 'edge', '2026-11-14': 'new' });
    expect(out.skipped).toEqual(['2026-10-01']);
  });
  it('leaves skipped absent when it was absent', () => {
    expect(prunePlanDayKeys(undefined, undefined, now)).toEqual({ paid: {} });
  });
});
