import type { CardType, TransactionType } from './types';

/**
 * Canonical card-balance delta for a transaction. Ported from `balanceDelta` in
 * the frontend `Transactions.tsx`.
 *
 *   credit cards: `balance` represents debt used, so the sign is inverted.
 *   debit / cash: `balance` is real money.
 *
 * The API uses THIS single rule for every money operation (transactions,
 * transfers, refills, returns, debts, deposits, subscriptions, savings). A few
 * frontend handlers historically grouped `cash` with `credit` for debts/savings;
 * normalising to this rule fixes that inconsistency for cash accounts.
 */
export function balanceDelta(cardType: CardType, txType: TransactionType, amount: number): number {
  const sign = cardType === 'credit' ? (txType === 'expense' ? 1 : -1) : txType === 'expense' ? -1 : 1;
  return amount * sign;
}
