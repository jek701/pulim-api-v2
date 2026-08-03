import { describe, expect, it } from 'vitest';
import { resolveAmount } from '../../src/telegram/resolve/amount';

describe('resolveAmount', () => {
  it.each([
    ['45к', 45_000, 'UZS'],
    ['45 K', 45_000, 'UZS'],
    ['45 ming', 45_000, 'UZS'],
    ['5 млн', 5_000_000, 'UZS'],
    ['1.2 mln', 1_200_000, 'UZS'],
    ['45.000', 45_000, 'UZS'],
    ['45 000', 45_000, 'UZS'],
    ['45,000', 45_000, 'UZS'],
    ['3.5$', 3.5, 'USD'],
    ['3,5 евро', 3.5, 'EUR'],
    ["20ming so'm", 20_000, 'UZS'],
    ['20 min', 20_000, 'UZS'],
    ['5mln', 5_000_000, 'UZS'],
    ['45.5к', 45_500, 'UZS'],
    ['50к сум', 50_000, 'UZS'],
    ['2 000 000', 2_000_000, 'UZS'],
    ['12.99$', 12.99, 'USD'],
    ['100000', 100_000, 'UZS'],
    ['2 млрд', 2_000_000_000, 'UZS'],
    ['7 mlrd', 7_000_000_000, 'UZS'],
    ['15 руб', 15, 'RUB'],
    ['8 USD', 8, 'USD'],
    ['9 €', 9, 'EUR'],
  ] as const)('parses %s', (literal, expected, currency) => {
    const result = resolveAmount(literal, expected, 'UZS');
    expect(result.amount).toBe(expected);
    expect(result.currency).toBe(currency);
    expect(result.ambiguous).toBe(false);
  });

  it('offers x1000 for a small implicit UZS amount', () => {
    expect(resolveAmount('45', 45, 'UZS')).toMatchObject({
      amount: 45,
      alternative: 45_000,
      reason: 'AMBIGUOUS_SMALL_AMOUNT',
    });
  });

  it('does not question an explicit small UZS amount', () => {
    expect(resolveAmount('45 сум', 45, 'UZS').ambiguous).toBe(false);
  });

  it('offers x1000 for 999 implicit UZS', () => {
    expect(resolveAmount('999', 999, 'UZS').alternative).toBe(999_000);
  });

  it('detects disagreement with the model', () => {
    expect(resolveAmount('45к', 45, 'UZS').reason).toBe('AMOUNT_MISMATCH');
  });

  it.each(['0', '-5', '1e20'])('rejects invalid amount %s', (literal) => {
    const result = resolveAmount(literal, Number(literal), 'UZS');
    expect(Number.isFinite(result.amount) && result.amount > 0).toBe(false);
  });
});
