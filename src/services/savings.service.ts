import { db, FieldValue } from '../config/firebase';
import { balanceDelta } from '../domain/balance';
import { cardsCol, savingsGoalsCol, newTxnRef, readOwned } from '../repositories/firestore.helpers';

type Row = Record<string, any>;

/** Contribute to a savings goal: increment savedAmount + optional account debit + expense transaction. */
export async function contribute(uid: string, goalId: string, amount: number, accountId?: string): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const goal = await readOwned(tx, savingsGoalsCol().doc(goalId), uid, 'Savings goal not found.');
    const account = accountId ? await readOwned(tx, cardsCol().doc(accountId), uid, 'Account not found.') : null;

    tx.update(goal.ref, { savedAmount: FieldValue.increment(amount) });
    const ref = newTxnRef();
    tx.set(ref, {
      type: 'expense', amount, currency: goal.data.currency, categoryId: '',
      source: 'savings', sourceLabel: `Savings: ${goal.data.name}`,
      ...(accountId ? { cardId: accountId } : {}), date: now, userId: uid, createdAt: now,
    });
    if (account) {
      tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, 'expense', amount)) });
    }
    return { id: goalId, contributed: amount };
  });
}
