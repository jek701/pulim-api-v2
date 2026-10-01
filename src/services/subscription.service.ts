import { db, FieldValue, Timestamp } from '../config/firebase';
import { balanceDelta } from '../domain/balance';
import { advanceBillingDate } from '../domain/billing';
import { cardsCol, subscriptionsCol, newTxnRef, readOwned } from '../repositories/firestore.helpers';
import { telegramOperationMarkerRef, telegramTransactionRef } from './transaction.service';

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

/** Idempotent subscription payment initiated by a Telegram notification. */
export async function payTelegramSubscriptionOnce(
  uid: string,
  input: { subscriptionId: string; accountId?: string; expectedNextBillingDate: number },
  operationKey: string,
): Promise<{
  subscriptionId: string;
  name: string;
  amount: number;
  currency: string;
  nextBillingDate: number;
  transactionId?: string;
  created: boolean;
}> {
  const markerRef = telegramOperationMarkerRef(uid, `subscription_payment:${operationKey}`);
  const transactionRef = telegramTransactionRef(
    `subscription_payment:${uid}:${operationKey}`,
    'telegram_sub_payment_',
  );
  return db.runTransaction(async (transaction) => {
    const marker = await transaction.get(markerRef);
    const subscription = await readOwned(
      transaction,
      subscriptionsCol().doc(input.subscriptionId),
      uid,
      'Subscription not found.',
    );
    const currentNextBillingDate = Number(subscription.data.nextBillingDate);
    const common = {
      subscriptionId: input.subscriptionId,
      name: String(subscription.data.name),
      amount: Number(subscription.data.amount),
      currency: String(subscription.data.currency),
    };
    if (marker.exists || currentNextBillingDate !== input.expectedNextBillingDate) {
      return {
        ...common,
        nextBillingDate: currentNextBillingDate,
        ...(marker.exists ? { transactionId: transactionRef.id } : {}),
        created: false,
      };
    }
    const account = input.accountId
      ? await readOwned(transaction, cardsCol().doc(input.accountId), uid, 'Account not found.')
      : null;
    if (account && account.data.currency !== subscription.data.currency) {
      throw new Error('Account currency does not match the subscription currency.');
    }
    const now = Date.now();
    const nextBillingDate = advanceBillingDate(currentNextBillingDate, subscription.data.cycle);
    const transactionDoc = {
      type: 'expense',
      amount: common.amount,
      currency: common.currency,
      categoryId: '__subscription__',
      source: 'subscription',
      sourceLabel: `${subscription.data.icon} ${common.name}`,
      ...(account ? { cardId: account.ref.id } : {}),
      origin: 'telegram',
      date: now,
      userId: uid,
      createdAt: now,
    };
    transaction.create(transactionRef, transactionDoc);
    if (account) {
      transaction.update(account.ref, {
        balance: FieldValue.increment(balanceDelta(account.data.cardType, 'expense', common.amount)),
      });
    }
    transaction.update(subscription.ref, { nextBillingDate });
    transaction.create(markerRef, {
      userId: uid,
      operationKey,
      kind: 'subscription_payment',
      subscriptionId: input.subscriptionId,
      transactionId: transactionRef.id,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86_400_000),
    });
    return { ...common, nextBillingDate, transactionId: transactionRef.id, created: true };
  });
}
