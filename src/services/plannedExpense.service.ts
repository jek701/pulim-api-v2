import { documentKey, patchValue, queryTable, runSqlTransaction } from '../db/documents';
import { balanceDelta } from '../domain/balance';
import { clientNow } from '../domain/clientTime';
import { prunePlanDayKeys } from '../domain/plannedPaid';
import {
  cardsCol,
  readOwned,
  resolveCreateTarget,
  txnsCol,
  writeCreated,
} from '../repositories/sql.helpers';
import { AppError } from '../utils/AppError';

type Row = Record<string, any>;
const plannedCol = () => queryTable('planned_expenses');

export interface SettleInput {
  day: string;
  accountId?: string;
  categoryId?: string;
  amount?: number;
  transactionId?: string;
  date?: number;
}

/**
 * "Mark paid / received" for one occurrence of a plan: ONE SQL transaction creates a normal
 * transaction (type = plan kind), applies the account balance exactly like paySubscription and
 * records `paid[day] = transactionId` on the plan.
 */
export async function settlePlannedExpense(uid: string, planId: string, input: SettleInput): Promise<Row> {
  const now = clientNow(input.date);
  return runSqlTransaction(async (tx) => {
    // Replay of an applied settle (offline client id): no second effect.
    const target = await resolveCreateTarget(tx, txnsCol(), uid, input.transactionId);
    const planRef = documentKey(plannedCol(), planId);
    const plan = await readOwned(tx, planRef, uid, 'Planned expense not found.');
    const paid = (plan.data.paid ?? {}) as Record<string, string>;
    if (target.existing) {
      if (paid[input.day] !== target.ref.id)
        throw AppError.conflict('ID_CONFLICT', 'This id cannot be used.');
      return { id: planId, paid, transaction: { id: target.ref.id } };
    }
    if (paid[input.day])
      throw AppError.conflict('ALREADY_SETTLED', 'This occurrence is already marked as paid.');
    const amount = input.amount ?? (plan.data.amount as number);
    const categoryId = input.categoryId ?? plan.data.categoryId;
    if (!categoryId) throw AppError.badRequest('A category is required.');
    // The request's account is the only one used: the plan's default account is just a pay-sheet preset.
    const accountId = input.accountId;
    const account = accountId
      ? await readOwned(tx, documentKey(cardsCol(), accountId), uid, 'Account not found.')
      : null;
    if (account && account.data.currency !== plan.data.currency)
      throw AppError.badRequest('Account currency does not match the plan currency.');
    const type = plan.data.kind ?? 'expense';
    writeCreated(tx, target, {
      type,
      amount,
      currency: plan.data.currency,
      categoryId,
      comment: plan.data.name,
      ...(account ? { cardId: account.ref.id } : {}),
      date: now,
      userId: uid,
      createdAt: now,
    });
    if (account) {
      tx.patch(account.ref, {
        balance: patchValue.increment(balanceDelta(account.data.cardType, type, amount)),
      });
    }
    const pruned = prunePlanDayKeys({ ...paid, [input.day]: target.ref.id }, plan.data.skipped, now);
    tx.patch(planRef, pruned);
    return { id: planId, paid: pruned.paid, transaction: { id: target.ref.id } };
  });
}
