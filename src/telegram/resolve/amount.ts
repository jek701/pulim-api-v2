import type { Currency } from '../../domain/types';

export interface AmountResult {
  amount: number;
  currency: Currency;
  alternative: number | null;
  ambiguous: boolean;
  reason: 'AMBIGUOUS_SMALL_AMOUNT' | 'AMOUNT_MISMATCH' | null;
}

const CURRENCY_PATTERNS: Array<[Currency, RegExp]> = [
  ['USD', /\$|\busd\b|долл|dollar/iu],
  ['EUR', /€|\beur\b|евро/iu],
  ['RUB', /₽|\brub\b|руб/iu],
  ['UZS', /\buzs\b|сум|сўм|so['ʻ’]?m|\bsom\b/iu],
];

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/(?:млрд|mlrd|billion|\bb\b)\.?\s*$/iu, 1_000_000_000],
  [/(?:млн|mln|million|мил|\bm\b)\.?\s*$/iu, 1_000_000],
  [/(?:тыс|ming|min|\bk\b|к)\.?\s*$/iu, 1_000],
];

function currencyFromLiteral(literal: string, fallback: Currency): Currency {
  return CURRENCY_PATTERNS.find(([, pattern]) => pattern.test(literal))?.[0] ?? fallback;
}

function parseNumeric(raw: string): number {
  let value = raw.trim().replace(/[−–—]/g, '-').replace(/\s+/g, '');
  if (/^[+-]?\d{1,3}([.,]\d{3})+$/.test(value)) {
    value = value.replace(/[.,]/g, '');
  } else if (value.includes('.') && value.includes(',')) {
    const decimalIndex = Math.max(value.lastIndexOf('.'), value.lastIndexOf(','));
    value = `${value.slice(0, decimalIndex).replace(/[.,]/g, '')}.${value.slice(decimalIndex + 1)}`;
  } else {
    const separator = value.includes(',') ? ',' : value.includes('.') ? '.' : null;
    if (separator) {
      const fraction = value.slice(value.lastIndexOf(separator) + 1);
      const thousands = fraction.length === 3 && value.indexOf(separator) === value.lastIndexOf(separator);
      value = thousands ? value.replace(separator, '') : value.replace(separator, '.');
    }
  }
  return Number(value);
}

export function resolveAmount(
  literal: string,
  modelAmount: number,
  modelCurrency: Currency,
): AmountResult {
  const currency = currencyFromLiteral(literal, modelCurrency);
  let cleaned = literal.trim().toLowerCase();
  for (const [, pattern] of CURRENCY_PATTERNS) cleaned = cleaned.replace(pattern, ' ');

  let multiplier = 1;
  let hadMultiplier = false;
  for (const [pattern, value] of MULTIPLIERS) {
    if (pattern.test(cleaned)) {
      multiplier = value;
      hadMultiplier = true;
      cleaned = cleaned.replace(pattern, '');
      break;
    }
  }

  const numericMatch = cleaned.match(/[+−–—-]?\d[\d\s.,]*(?:[eE][+-]?\d+)?/u);
  const parsedAmount = numericMatch ? parseNumeric(numericMatch[0]) * multiplier : Number.NaN;
  const amount = currency === 'UZS' ? Math.round(parsedAmount) : parsedAmount;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e15) {
    return { amount: Number.NaN, currency, alternative: null, ambiguous: false, reason: null };
  }

  const mismatch = Number.isFinite(modelAmount) && modelAmount > 0
    && Math.abs(amount - modelAmount) / Math.max(amount, modelAmount) > 0.001;
  if (mismatch) {
    return { amount, currency, alternative: null, ambiguous: true, reason: 'AMOUNT_MISMATCH' };
  }

  const hadExplicitUzs = CURRENCY_PATTERNS.find(([code]) => code === 'UZS')![1].test(literal);
  if (currency === 'UZS' && amount < 1_000 && !hadMultiplier && !hadExplicitUzs) {
    return {
      amount,
      currency,
      alternative: amount * 1_000,
      ambiguous: true,
      reason: 'AMBIGUOUS_SMALL_AMOUNT',
    };
  }
  return { amount, currency, alternative: null, ambiguous: false, reason: null };
}
