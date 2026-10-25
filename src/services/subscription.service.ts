import { Timestamp, documentKey, patchValue, runSqlTransaction } from '../db/documents';
import { balanceDelta } from '../domain/balance';
import { advanceBillingDate } from '../domain/billing';
import {
  cardsCol,
  subscriptionsCol,
  readOwned,
  resolveOperationTx,
  writeCreated,
} from '../repositories/sql.helpers';
import { telegramOperationMarkerRef, telegramTransactionRef } from './transaction.service';
type Row = Record<string, any>;
/** Record a subscription payment: expense transaction + optional balance + advance nextBillingDate. */
export async function paySubscription(
  uid: string,
  subscriptionId: string,
  accountId?: string,
  transactionId?: string,
): Promise<Row> {
  const now = Date.now();
  return runSqlTransaction(async (tx) => {
    // Replay of an applied payment (offline client id): no second effect.
    const target = await resolveOperationTx(tx, uid, transactionId, 'subscription');
    if (target.existing) {
      const current = await readOwned(
        tx,
        documentKey(subscriptionsCol(), subscriptionId),
        uid,
        'Subscription not found.',
      );
      return {
        id: subscriptionId,
        nextBillingDate: current.data.nextBillingDate,
        transaction: { id: target.ref.id },
      };
    }
    const sub = await readOwned(
      tx,
      documentKey(subscriptionsCol(), subscriptionId),
      uid,
      'Subscription not found.',
    );
    const account = accountId
      ? await readOwned(tx, documentKey(cardsCol(), accountId), uid, 'Account not found.')
      : null;
    const amount = sub.data.amount as number;
    const nextBillingDate = advanceBillingDate(sub.data.nextBillingDate, sub.data.cycle);
    const ref = target.ref;
    writeCreated(tx, target, {
      type: 'expense',
      amount,
      currency: sub.data.currency,
      categoryId: '__subscription__',
      source: 'subscription',
      sourceLabel: `${sub.data.icon} ${sub.data.name}`,
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
    tx.patch(sub.ref, { nextBillingDate });
    return { id: subscriptionId, nextBillingDate, transaction: { id: ref.id } };
  });
}
/** Idempotent subscription payment initiated by a Telegram notification. */
export async function payTelegramSubscriptionOnce(
  uid: string,
  input: {
    subscriptionId: string;
    accountId?: string;
    expectedNextBillingDate: number;
  },
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
  return runSqlTransaction(async (transaction) => {
    const marker = await transaction.read(markerRef);
    const subscription = await readOwned(
      transaction,
      documentKey(subscriptionsCol(), input.subscriptionId),
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
      ? await readOwned(
          transaction,
          documentKey(cardsCol(), input.accountId),
          uid,
          'Account not found.',
        )
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
    transaction.insert(transactionRef, transactionDoc);
    if (account) {
      transaction.patch(account.ref, {
        balance: patchValue.increment(
          balanceDelta(account.data.cardType, 'expense', common.amount),
        ),
      });
    }
    transaction.patch(subscription.ref, { nextBillingDate });
    transaction.insert(markerRef, {
      userId: uid,
      operationKey,
      kind: 'subscription_payment',
      subscriptionId: input.subscriptionId,
      transactionId: transactionRef.id,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86400000),
    });
    return { ...common, nextBillingDate, transactionId: transactionRef.id, created: true };
  });
}
