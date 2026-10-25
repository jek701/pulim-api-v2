import { documentKey, patchValue, runSqlTransaction } from '../db/documents';
import { balanceDelta } from '../domain/balance';
import { clientNow } from '../domain/clientTime';
import {
  cardsCol,
  savingsGoalsCol,
  readOwned,
  resolveOperationTx,
  writeCreated,
} from '../repositories/sql.helpers';
type Row = Record<string, any>;
/** Contribute to a savings goal: increment savedAmount + optional account debit + expense transaction. */
export async function contribute(
  uid: string,
  goalId: string,
  amount: number,
  accountId?: string,
  transactionId?: string,
  date?: number,
): Promise<Row> {
  const now = clientNow(date);
  return runSqlTransaction(async (tx) => {
    // Replay of an applied contribution (offline client id): no second effect.
    const target = await resolveOperationTx(tx, uid, transactionId, 'savings');
    if (target.existing) return { id: goalId, contributed: target.existing.amount };
    const goal = await readOwned(
      tx,
      documentKey(savingsGoalsCol(), goalId),
      uid,
      'Savings goal not found.',
    );
    const account = accountId
      ? await readOwned(tx, documentKey(cardsCol(), accountId), uid, 'Account not found.')
      : null;
    tx.patch(goal.ref, { savedAmount: patchValue.increment(amount) });
    writeCreated(tx, target, {
      type: 'expense',
      amount,
      currency: goal.data.currency,
      categoryId: '',
      source: 'savings',
      sourceLabel: `Savings: ${goal.data.name}`,
      ...(accountId ? { cardId: accountId } : {}),
      date: now,
      userId: uid,
      createdAt: now,
    });
    if (account) {
      tx.patch(account.ref, {
        balance: patchValue.increment(balanceDelta(account.data.cardType, 'expense', amount)),
      });
    }
    return { id: goalId, contributed: amount };
  });
}
