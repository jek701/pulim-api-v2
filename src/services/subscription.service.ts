import { db, FieldValue } from '../config/firebase';
import { balanceDelta } from '../domain/balance';
import { advanceBillingDate } from '../domain/billing';
import { cardsCol, subscriptionsCol, newTxnRef, readOwned } from '../repositories/firestore.helpers';

type Row = Record<string, any>;

/** Record a subscription payment: expense transaction + optional balance + advance nextBillingDate. */
export async function paySubscription(uid: string, subscriptionId: string, accountId?: string): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const sub = await readOwned(tx, subscriptionsCol().doc(subscriptionId), uid, 'Subscription not found.');
    const account = accountId ? await readOwned(tx, cardsCol().doc(accountId), uid, 'Account not found.') : null;

    const amount = sub.data.amount as number;
    const nextBillingDate = advanceBillingDate(sub.data.nextBillingDate, sub.data.cycle);

    const ref = newTxnRef();
    tx.set(ref, {
      type: 'expense', amount, currency: sub.data.currency, categoryId: '__subscription__',
      source: 'subscription', sourceLabel: `${sub.data.icon} ${sub.data.name}`,
      ...(accountId ? { cardId: accountId } : {}), date: now, userId: uid, createdAt: now,
    });
    if (account) {
      tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, 'expense', amount)) });
    }
    tx.update(sub.ref, { nextBillingDate });
    return { id: subscriptionId, nextBillingDate, transaction: { id: ref.id } };
  });
}
