import { db, FieldValue } from '../config/firebase';
import { AppError } from '../utils/AppError';
import { balanceDelta } from '../domain/balance';
import {
  cardsCol,
  txnsCol,
  newTxnRef,
  readOwned,
  tryReadOwned,
  type OwnedDoc,
} from '../repositories/firestore.helpers';

type Row = Record<string, any>;

/** Create a transaction and, if it references a card, adjust that card's balance atomically. */
export async function createTransaction(uid: string, input: Row): Promise<Row> {
  return db.runTransaction(async (tx) => {
    const card = input.cardId
      ? await readOwned(tx, cardsCol().doc(input.cardId), uid, 'Card not found.')
      : null;

    const ref = newTxnRef();
    const doc = { ...input, userId: uid, createdAt: Date.now() };
    tx.set(ref, doc);

    if (card) {
      const delta = balanceDelta(card.data.cardType, input.type, input.amount);
      tx.update(card.ref, { balance: FieldValue.increment(delta) });
    }
    return { id: ref.id, ...doc };
  });
}

/** Edit a transaction: atomically revert the old balance impact and apply the new one. */
export async function updateTransaction(uid: string, id: string, patch: Row): Promise<Row> {
  return db.runTransaction(async (tx) => {
    const original = await readOwned(tx, txnsCol().doc(id), uid, 'Transaction not found.');
    const old = original.data;
    const merged = { ...old, ...patch };
    const oldCardId: string | undefined = old.cardId;
    const newCardId: string | undefined = merged.cardId;

    // All reads first.
    const oldCard = oldCardId ? await tryReadOwned(tx, cardsCol().doc(oldCardId), uid) : null;
    const newCard =
      newCardId && newCardId === oldCardId
        ? oldCard
        : newCardId
          ? await tryReadOwned(tx, cardsCol().doc(newCardId), uid)
          : null;

    // Then writes.
    if (oldCard && newCard && oldCardId === newCardId) {
      const net =
        -balanceDelta(oldCard.data.cardType, old.type, old.amount) +
        balanceDelta(oldCard.data.cardType, merged.type, merged.amount);
      if (net !== 0) tx.update(oldCard.ref, { balance: FieldValue.increment(net) });
    } else {
      if (oldCard) {
        tx.update(oldCard.ref, {
          balance: FieldValue.increment(-balanceDelta(oldCard.data.cardType, old.type, old.amount)),
        });
      }
      if (newCard) {
        tx.update(newCard.ref, {
          balance: FieldValue.increment(balanceDelta(newCard.data.cardType, merged.type, merged.amount)),
        });
      }
    }

    tx.set(original.ref, patch, { merge: true });
    return { id, ...merged };
  });
}

/**
 * Delete a transaction, reversing its balance impact (handles transfers' two legs)
 * and keeping refund links consistent:
 *
 *  - deleting an expense that has refunds also deletes those refunds, otherwise they
 *    survive as orphans pointing at a missing original — phantom income plus an
 *    inflated card balance;
 *  - deleting a refund gives its `returnedAmount` back to the original, otherwise the
 *    original keeps claiming it was partially refunded forever.
 */
export async function deleteTransaction(uid: string, id: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const { ref, data } = await readOwned(tx, txnsCol().doc(id), uid, 'Transaction not found.');

    // ---- reads first (Firestore transactions forbid reads after writes) ----

    // Equality-only filters, so single-field indexes are enough — no composite index.
    const linkedSnap = await tx.get(
      txnsCol().where('userId', '==', uid).where('linkedTransactionId', '==', id),
    );
    const linked = linkedSnap.docs.map((d) => ({ ref: d.ref, data: d.data() }));

    // Cards are deduped by id: two refunds to the same card must not each read it.
    const cardIds = new Set<string>();
    if (data.cardId) cardIds.add(data.cardId);
    if (data.source === 'transfer' && data.toCardId) cardIds.add(data.toCardId);
    for (const l of linked) if (l.data.cardId) cardIds.add(l.data.cardId);

    const cards = new Map<string, OwnedDoc | null>();
    for (const cardId of cardIds) {
      cards.set(cardId, await tryReadOwned(tx, cardsCol().doc(cardId), uid));
    }

    const originalRef =
      data.source === 'return' && data.linkedTransactionId
        ? txnsCol().doc(data.linkedTransactionId)
        : null;
    const original = originalRef ? await tryReadOwned(tx, originalRef, uid) : null;

    // ---- then writes ----

    // Net the balance changes per card so one card gets a single increment.
    const balanceChanges = new Map<string, number>();
    const applyDelta = (cardId: string | undefined, delta: number) => {
      if (!cardId || delta === 0) return;
      balanceChanges.set(cardId, (balanceChanges.get(cardId) ?? 0) + delta);
    };

    if (data.source === 'transfer' && data.toCardId) {
      const fromCard = data.cardId ? cards.get(data.cardId) : null;
      const toCard = cards.get(data.toCardId);
      const toAmt = data.toAmount ?? data.amount;
      if (fromCard) {
        applyDelta(data.cardId, -balanceDelta(fromCard.data.cardType, 'expense', data.amount));
      }
      if (toCard) {
        applyDelta(data.toCardId, -balanceDelta(toCard.data.cardType, 'income', toAmt));
      }
    } else if (data.cardId) {
      const card = cards.get(data.cardId);
      if (card) {
        applyDelta(data.cardId, -balanceDelta(card.data.cardType, data.type, data.amount));
      }
    }

    for (const l of linked) {
      const card = l.data.cardId ? cards.get(l.data.cardId) : null;
      if (card) {
        applyDelta(l.data.cardId, -balanceDelta(card.data.cardType, l.data.type, l.data.amount));
      }
      tx.delete(l.ref);
    }

    if (original) {
      tx.update(original.ref, { returnedAmount: FieldValue.increment(-data.amount) });
    }

    for (const [cardId, delta] of balanceChanges) {
      const card = cards.get(cardId);
      if (card) tx.update(card.ref, { balance: FieldValue.increment(delta) });
    }

    tx.delete(ref);
  });
}

/**
 * Delete ALL of a user's transactions (the Settings "clear data" action).
 * Matches the frontend: a bulk wipe that does NOT reverse card balances.
 */
export async function clearAllTransactions(uid: string): Promise<{ deleted: number }> {
  let deleted = 0;
  for (;;) {
    const snap = await txnsCol().where('userId', '==', uid).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 400) break;
  }
  return { deleted };
}

/** Card-to-card transfer recorded as one transaction plus both balance adjustments. */
export async function transfer(
  uid: string,
  input: {
    fromCardId: string;
    toCardId: string;
    amount: number;
    toAmount?: number;
    baseAmount?: number;
    fxRate?: number;
    fxRateSource?: 'NBU' | 'manual';
  },
): Promise<Row> {
  if (input.fromCardId === input.toCardId) {
    throw AppError.badRequest('Cannot transfer to the same card.');
  }
  return db.runTransaction(async (tx) => {
    const from = await readOwned(tx, cardsCol().doc(input.fromCardId), uid, 'Source card not found.');
    const to = await readOwned(tx, cardsCol().doc(input.toCardId), uid, 'Destination card not found.');

    const differentCurrencies = from.data.currency !== to.data.currency;
    const toAmt = differentCurrencies ? input.toAmount : (input.toAmount ?? input.amount);
    if (!toAmt || toAmt <= 0) {
      throw AppError.badRequest('toAmount is required (and > 0) for cross-currency transfers.');
    }

    const ref = newTxnRef();
    const doc = {
      type: 'expense',
      amount: input.amount,
      currency: from.data.currency,
      toCardId: input.toCardId,
      toAmount: toAmt,
      toCurrency: to.data.currency,
      categoryId: '',
      source: 'transfer',
      sourceLabel: `Transfer: ${from.data.name} -> ${to.data.name}`,
      cardId: input.fromCardId,
      baseAmount: input.baseAmount,
      fxRate: input.fxRate,
      fxRateSource: input.fxRateSource,
      date: Date.now(),
      userId: uid,
      createdAt: Date.now(),
    };
    tx.set(ref, doc);
    tx.update(from.ref, {
      balance: FieldValue.increment(balanceDelta(from.data.cardType, 'expense', input.amount)),
    });
    tx.update(to.ref, { balance: FieldValue.increment(balanceDelta(to.data.cardType, 'income', toAmt)) });
    return { id: ref.id, ...doc };
  });
}

/** Refund (partial or full) an existing transaction, capped at its remaining returnable amount. */
export async function returnTransaction(
  uid: string,
  originalId: string,
  input: { returnAmount: number; accountId?: string; date?: number },
): Promise<Row> {
  return db.runTransaction(async (tx) => {
    const original = await readOwned(tx, txnsCol().doc(originalId), uid, 'Original transaction not found.');
    const o = original.data;
    const remaining = (o.amount as number) - (o.returnedAmount ?? 0);
    if (input.returnAmount > remaining) {
      throw AppError.badRequest('Return amount exceeds the remaining returnable amount.', { remaining });
    }

    const account = input.accountId
      ? await readOwned(tx, cardsCol().doc(input.accountId), uid, 'Card not found.')
      : null;

    const ref = newTxnRef();
    const doc = {
      type: 'income',
      amount: input.returnAmount,
      currency: o.currency,
      categoryId: o.categoryId,
      cardId: input.accountId,
      source: 'return',
      sourceLabel: 'Return',
      linkedTransactionId: originalId,
      date: input.date ?? Date.now(),
      userId: uid,
      createdAt: Date.now(),
    };
    tx.set(ref, doc);
    tx.update(original.ref, { returnedAmount: FieldValue.increment(input.returnAmount) });
    if (account) {
      tx.update(account.ref, {
        balance: FieldValue.increment(balanceDelta(account.data.cardType, 'income', input.returnAmount)),
      });
    }
    return { id: ref.id, ...doc };
  });
}
