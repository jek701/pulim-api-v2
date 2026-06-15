import type { Deposit } from './types';

// Ported from the frontend `Deposits.tsx` interest helpers.

const MS_365 = 365 * 86_400_000;

export function trancheSum(deposit: Pick<Deposit, 'tranches'>): number {
  return (deposit.tranches ?? []).reduce((s, t) => s + t.amount, 0);
}

export function calcCurrentPrincipal(deposit: Deposit): number {
  return deposit.amount + trancheSum(deposit);
}

export function calcTotalAccrued(deposit: Deposit, now: number): number {
  const rate = deposit.interestRate / 100;
  const end = Math.min(now, deposit.endDate);

  let interest = (deposit.amount * rate * Math.max(0, end - deposit.startDate)) / MS_365;
  for (const t of deposit.tranches ?? []) {
    if (t.date < end) {
      interest += (t.amount * rate * (end - t.date)) / MS_365;
    }
  }
  return Math.max(0, interest);
}

export function calcRemainingInterest(deposit: Deposit, now: number): number {
  return Math.max(0, calcTotalAccrued(deposit, now) - deposit.interestPaidOut);
}
