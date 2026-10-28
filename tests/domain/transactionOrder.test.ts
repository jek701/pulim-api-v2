import { describe, expect, it } from 'vitest';

import { compareTransactions, transactionDay } from '../../src/domain/transactionOrder';

const H = 60 * 60 * 1000;
// 2026-10-28 00:00 UTC = 05:00 in Tashkent.
const DAY = Date.UTC(2026, 9, 28);
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe('compareTransactions', () => {
  it('puts the most recently added first inside a day, even if an older one carries a clock time', () => {
    const transfer = { id: 'transfer', date: DAY + 9 * H, createdAt: 1_000 }; // added first, has a time
    const expense = { id: 'expense', date: DAY, createdAt: 2_000 }; // added later, midnight date
    expect(ids([transfer, expense].sort(compareTransactions))).toEqual(['expense', 'transfer']);
  });

  it('keeps newer days above older days', () => {
    const today = { id: 'today', date: DAY, createdAt: 1 };
    const yesterday = { id: 'yesterday', date: DAY - 24 * H, createdAt: 9_999 };
    expect(ids([yesterday, today].sort(compareTransactions))).toEqual(['today', 'yesterday']);
  });

  it('a backdated entry added now is the top of its own (older) day', () => {
    const first = { id: 'first', date: DAY - 24 * H, createdAt: 10 };
    const backdated = { id: 'backdated', date: DAY - 24 * H, createdAt: 99 };
    const today = { id: 'today', date: DAY, createdAt: 5 };
    expect(ids([first, backdated, today].sort(compareTransactions))).toEqual(['today', 'backdated', 'first']);
  });

  it('groups by the Tashkent day, like the clients do', () => {
    // 02:00 Tashkent on the 28th is 21:00 UTC on the 27th: still the 28th for the user.
    const lateNight = Date.UTC(2026, 9, 27, 21, 0, 0);
    expect(transactionDay(lateNight)).toBe(transactionDay(DAY));
    expect(transactionDay(lateNight - 6 * H)).toBe(transactionDay(DAY) - 1);
  });

  it('tolerates missing fields', () => {
    expect(ids([{ id: 'a' }, { id: 'b', date: DAY, createdAt: 1 }].sort(compareTransactions))).toEqual(['b', 'a']);
  });
});
