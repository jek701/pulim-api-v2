import { describe, expect, it } from 'vitest';
import type { Card } from '../../src/domain/types';
import { resolveCard } from '../../src/telegram/resolve/card';

const card = (patch: Partial<Card> = {}): Card => ({
  id: 'one', cardType: 'debit', name: 'Humo', bank: 'Kapital', currency: 'UZS',
  balance: 100_000, userId: 'u', createdAt: 1, ...patch,
});

describe('resolveCard', () => {
  it('allows transactions without cards', () => {
    expect(resolveCard({ cardHint: '' }, [], [], 10, 'UZS', 'expense')).toEqual({
      cardId: undefined, ambiguous: false, reason: 'NO_CARDS',
    });
  });

  it('chooses a sufficiently funded recent card', () => {
    const cards = [card(), card({ id: 'two', name: 'Cash', balance: 500_000 })];
    expect(resolveCard({ cardHint: '' }, cards, ['one', 'two'], 200_000, 'UZS', 'expense').cardId).toBe('two');
  });

  it('uses available credit limit', () => {
    const credit = card({ id: 'credit', cardType: 'credit', limit: 1_000, balance: 700 });
    expect(resolveCard({ cardHint: '' }, [credit], [], 300, 'UZS', 'expense').ambiguous).toBe(false);
  });

  it('flags currency mismatch', () => {
    expect(resolveCard({ cardHint: '' }, [card()], [], 3, 'USD', 'expense').reason).toBe('NO_CARD_IN_CURRENCY');
  });

  it('uses the most recent card of any currency as mismatch fallback', () => {
    const cards = [card({ id: 'uzs' }), card({ id: 'eur', currency: 'EUR' })];
    expect(resolveCard({ cardHint: '' }, cards, ['eur', 'uzs'], 3, 'USD', 'expense').cardId).toBe('eur');
  });

  it('puts a newer unused card first when no history exists', () => {
    const cards = [card({ id: 'old', createdAt: 1 }), card({ id: 'new', createdAt: 2 })];
    expect(resolveCard({ cardHint: '' }, cards, [], 1, 'UZS', 'income').cardId).toBe('new');
  });

  it('chooses the most recent matching card for income', () => {
    const cards = [card({ id: 'one' }), card({ id: 'two' })];
    expect(resolveCard({ cardHint: '' }, cards, ['two', 'one'], 10, 'UZS', 'income').cardId).toBe('two');
  });

  it('flags insufficient funds everywhere', () => {
    expect(resolveCard({ cardHint: '' }, [card({ balance: 1 })], [], 10, 'UZS', 'expense').reason)
      .toBe('INSUFFICIENT_FUNDS');
  });

  it('honours an explicit unique hint without checking funds', () => {
    expect(resolveCard({ cardHint: 'kapital' }, [card({ balance: 0 })], [], 10, 'UZS', 'expense')).toMatchObject({
      cardId: 'one', ambiguous: false,
    });
  });

  it('flags an ambiguous explicit hint', () => {
    const cards = [card({ id: 'one' }), card({ id: 'two', name: 'Humo 2' })];
    expect(resolveCard({ cardHint: 'humo' }, cards, [], 10, 'UZS', 'expense').reason)
      .toBe('AMBIGUOUS_CARD_HINT');
  });
});
