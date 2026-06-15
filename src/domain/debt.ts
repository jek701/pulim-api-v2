import type { Commission } from './types';

/** Total owed including commission. Ported from `calcTotal` in `Debts.tsx`. */
export function calcDebtTotal(amount: number, commission?: Commission): number {
  if (!commission) return amount;
  return commission.type === 'percent'
    ? amount + amount * (commission.value / 100)
    : amount + commission.value;
}
