import { db, FieldValue, Timestamp } from '../config/firebase';
import { createHash } from 'node:crypto';
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

export function telegramOperationMarkerRef(uid: string, operationKey: string) {
  return db.collection('telegramOperations').doc(
    createHash('sha256').update(`${uid}:${operationKey}`).digest('hex'),
  );
}

export function telegramTransactionRef(operationKey: string, prefix = 'telegram_') {
  const digest = createHash('sha256').update(operationKey).digest('hex').slice(0, 40);
  return txnsCol().doc(`${prefix}${digest}`);
}

/**
 * Idempotent Telegram money write. The operation marker, optional draft transition,
 * transaction document, and card balance are committed together.
 */
export async function createTelegramTransactionOnce(
  uid: string,
  input: Row,
  operationKey: string,
  draftId?: string,
): Promise<{ transaction: Row; created: boolean }> {
  if (!input.categoryId) throw AppError.badRequest('A category is required.');
  if (input.currency !== 'UZS' && (!input.baseAmount || !input.fxRate || input.fxRateSource !== 'NBU')) {
    throw AppError.badRequest('An NBU exchange-rate snapshot is required for foreign currency.');
  }

  const markerRef = telegramOperationMarkerRef(uid, operationKey);
  const transactionRef = telegramTransactionRef(`${uid}:${operationKey}`);
  const draftRef = draftId ? db.collection('telegramDrafts').doc(draftId) : null;

  return db.runTransaction(async (tx) => {
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      const existing = await tx.get(transactionRef);
      if (!existing.exists) throw new Error('Telegram operation marker has no transaction.');
      return { transaction: { id: existing.id, ...existing.data() }, created: false };
    }

    const draft = draftRef ? await readOwned(tx, draftRef, uid, 'Telegram draft not found.') : null;
    if (draft && !['pending', 'waiting_fx'].includes(String(draft.data.status))) {
      if (draft.data.transactionId) {
        const existing = await tx.get(txnsCol().doc(String(draft.data.transactionId)));
        if (existing.exists) return { transaction: { id: existing.id, ...existing.data() }, created: false };
      }
      throw AppError.badRequest('Telegram draft is no longer pending.');
    }

    await readOwned(
      tx,
      db.collection('categories').doc(String(input.categoryId)),
      uid,
      'Category not found.',
    );
    if (input.subcategoryId) {
      const subcategory = await readOwned(
        tx,
        db.collection('subcategories').doc(String(input.subcategoryId)),
        uid,
        'Subcategory not found.',
      );
      if (subcategory.data.categoryId !== input.categoryId) {
        throw AppError.badRequest('Subcategory does not belong to the selected category.');
      }
    }

    const card = input.cardId
      ? await readOwned(tx, cardsCol().doc(input.cardId), uid, 'Card not found.')
      : null;
    const now = Date.now();
    const doc = { ...input, origin: 'telegram', userId: uid, createdAt: now };

    tx.create(transactionRef, doc);
    if (card) {
      const delta = balanceDelta(card.data.cardType, input.type, input.amount);
      tx.update(card.ref, { balance: FieldValue.increment(delta) });
    }
    if (draftRef) {
      tx.set(draftRef, {
        status: 'confirmed',
        transactionId: transactionRef.id,
        updatedAt: now,
      }, { merge: true });
    }
    tx.create(markerRef, {
      userId: uid,
      operationKey,
      transactionId: transactionRef.id,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86_400_000),
    });
    return { transaction: { id: transactionRef.id, ...doc }, created: true };
  });
}

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
    if (old.source) {
      throw AppError.badRequest(
        'This operation must be edited through its dedicated endpoint.',
        { source: old.source },
      );
    }
    const merged = { ...old, ...patch };
    const categoryChanged = typeof patch.categoryId === 'string' && patch.categoryId !== old.categoryId;
    if (categoryChanged && !patch.subcategoryId) delete merged.subcategoryId;
    if ((old.returnedAmount ?? 0) > 0) {
      if (merged.type !== 'expense') {
        throw AppError.badRequest('A refunded expense cannot be converted to income.');
      }
      if (merged.amount < old.returnedAmount) {
        throw AppError.badRequest('Amount cannot be lower than the amount already returned.', {
          returnedAmount: old.returnedAmount,
        });
      }
      if (merged.currency !== old.currency) {
        throw AppError.badRequest('Currency cannot be changed after a return has been recorded.');
      }
    }
    const linkedRefunds = (old.returnedAmount ?? 0) > 0
      ? await tx.get(
          txnsCol().where('userId', '==', uid).where('linkedTransactionId', '==', id),
        )
      : null;
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

    const writePatch = { ...patch };
    if (categoryChanged && !patch.subcategoryId) {
      writePatch.subcategoryId = FieldValue.delete();
    }
    tx.set(original.ref, writePatch, { merge: true });
    if (categoryChanged && linkedRefunds) {
      for (const linked of linkedRefunds.docs) {
        tx.set(linked.ref, {
          categoryId: merged.categoryId,
          subcategoryId: merged.subcategoryId ?? FieldValue.delete(),
        }, { merge: true });
      }
    }
    return { id, ...merged };
  });
}

type TransferUpdateInput = {
  fromCardId: string;
  toCardId: string;
  amount: number;
  toAmount?: number;
  baseAmount?: number;
  fxRate?: number;
  fxRateSource?: 'NBU' | 'manual';
  date: number;
  comment?: string;
};

/** Edit both transfer legs as one atomic operation. */
export async function updateTransfer(
  uid: string,
  id: string,
  input: TransferUpdateInput,
): Promise<Row> {
  if (input.fromCardId === input.toCardId) {
    throw AppError.badRequest('Cannot transfer to the same card.');
  }

  return db.runTransaction(async (tx) => {
    const original = await readOwned(tx, txnsCol().doc(id), uid, 'Transfer not found.');
    const old = original.data;
    if (old.source !== 'transfer' || !old.cardId || !old.toCardId) {
      throw AppError.badRequest('Transaction is not a transfer.');
    }

    // Firestore requires every read to happen before the first write.
    const ids = new Set<string>([
      old.cardId,
      old.toCardId,
      input.fromCardId,
      input.toCardId,
    ]);
    const cards = new Map<string, OwnedDoc>();
    for (const cardId of ids) {
      cards.set(cardId, await readOwned(tx, cardsCol().doc(cardId), uid, 'Card not found.'));
    }

    const from = cards.get(input.fromCardId)!;
    const to = cards.get(input.toCardId)!;
    const differentCurrencies = from.data.currency !== to.data.currency;
    const toAmount = differentCurrencies ? input.toAmount : input.amount;
    if (!toAmount || toAmount <= 0) {
      throw AppError.badRequest('toAmount is required (and > 0) for cross-currency transfers.');
    }

    const changes = new Map<string, number>();
    const change = (cardId: string, delta: number) => {
      changes.set(cardId, (changes.get(cardId) ?? 0) + delta);
    };
    const oldFrom = cards.get(old.cardId)!;
    const oldTo = cards.get(old.toCardId)!;
    change(old.cardId, -balanceDelta(oldFrom.data.cardType, 'expense', old.amount));
    change(old.toCardId, -balanceDelta(oldTo.data.cardType, 'income', old.toAmount ?? old.amount));
    change(input.fromCardId, balanceDelta(from.data.cardType, 'expense', input.amount));
    change(input.toCardId, balanceDelta(to.data.cardType, 'income', toAmount));

    const doc = {
      type: 'expense',
      amount: input.amount,
      currency: from.data.currency,
      categoryId: '',
      cardId: input.fromCardId,
      toCardId: input.toCardId,
      toAmount,
      toCurrency: to.data.currency,
      source: 'transfer',
      sourceLabel: `Transfer: ${from.data.name} -> ${to.data.name}`,
      ...(input.comment ? { comment: input.comment } : {}),
      baseAmount: input.baseAmount,
      fxRate: input.fxRate,
      fxRateSource: input.fxRateSource,
      date: input.date,
      userId: uid,
      createdAt: old.createdAt,
    };

    for (const [cardId, delta] of changes) {
      if (delta !== 0) tx.update(cards.get(cardId)!.ref, { balance: FieldValue.increment(delta) });
    }
    // Replace the document so stale category/subcategory or normal-transaction
    // fields cannot survive an earlier broken edit.
    tx.set(original.ref, doc);
    return { id, ...doc };
  });
}

type ReturnUpdateInput = {
  returnAmount: number;
  accountId?: string;
  date: number;
  comment?: string;
};

const returnFxFields = (original: Row, amount: number): Row => {
  if (typeof original.fxRate === 'number' && original.fxRate > 0) {
    return {
      baseAmount: Math.round(amount * original.fxRate),
      fxRate: original.fxRate,
      fxRateSource: original.fxRateSource,
    };
  }
  if (typeof original.baseAmount === 'number' && original.amount > 0) {
    return { baseAmount: Math.round((original.baseAmount / original.amount) * amount) };
  }
  return {};
};

/** Edit a refund while keeping the original purchase and receiving account in sync. */
export async function updateReturn(
  uid: string,
  id: string,
  input: ReturnUpdateInput,
): Promise<Row> {
  return db.runTransaction(async (tx) => {
    const refund = await readOwned(tx, txnsCol().doc(id), uid, 'Return not found.');
    const old = refund.data;
    if (old.source !== 'return' || !old.linkedTransactionId) {
      throw AppError.badRequest('Transaction is not a return.');
    }

    const original = await readOwned(
      tx,
      txnsCol().doc(old.linkedTransactionId),
      uid,
      'Original transaction not found.',
    );
    const purchase = original.data;
    const oldAccount = old.cardId
      ? await tryReadOwned(tx, cardsCol().doc(old.cardId), uid)
      : null;
    const newAccount = input.accountId
      ? input.accountId === old.cardId
        ? oldAccount
        : await readOwned(tx, cardsCol().doc(input.accountId), uid, 'Card not found.')
      : null;

    if (newAccount && newAccount.data.currency !== purchase.currency) {
      throw AppError.badRequest('Return account currency must match the original transaction currency.');
    }

    const otherReturned = Math.max(0, (purchase.returnedAmount ?? 0) - old.amount);
    const maxReturn = purchase.amount - otherReturned;
    if (input.returnAmount > maxReturn) {
      throw AppError.badRequest('Return amount exceeds the remaining returnable amount.', {
        remaining: maxReturn,
      });
    }

    if (oldAccount && newAccount && old.cardId === input.accountId) {
      const net =
        -balanceDelta(oldAccount.data.cardType, 'income', old.amount) +
        balanceDelta(newAccount.data.cardType, 'income', input.returnAmount);
      if (net !== 0) tx.update(oldAccount.ref, { balance: FieldValue.increment(net) });
    } else {
      if (oldAccount) {
        tx.update(oldAccount.ref, {
          balance: FieldValue.increment(-balanceDelta(oldAccount.data.cardType, 'income', old.amount)),
        });
      }
      if (newAccount) {
        tx.update(newAccount.ref, {
          balance: FieldValue.increment(balanceDelta(newAccount.data.cardType, 'income', input.returnAmount)),
        });
      }
    }

    const doc = {
      type: 'income',
      amount: input.returnAmount,
      currency: purchase.currency,
      categoryId: purchase.categoryId ?? '',
      ...(purchase.subcategoryId ? { subcategoryId: purchase.subcategoryId } : {}),
      ...(input.accountId ? { cardId: input.accountId } : {}),
      source: 'return',
      sourceLabel: 'Return',
      linkedTransactionId: old.linkedTransactionId,
      ...(input.comment ? { comment: input.comment } : {}),
      ...returnFxFields(purchase, input.returnAmount),
      date: input.date,
      userId: uid,
      createdAt: old.createdAt,
    };
    tx.update(original.ref, { returnedAmount: otherReturned + input.returnAmount });
    tx.set(refund.ref, doc);
    return { id, ...doc };
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

/** Idempotent Telegram card-to-card transfer. Both balances and the transfer row
 * are committed together so retries cannot duplicate money movement. */
export async function createTelegramTransferOnce(
  uid: string,
  input: {
    fromCardId: string;
    toCardId: string;
    amount: number;
    toAmount?: number;
    baseAmount?: number;
    fxRate?: number;
    fxRateSource?: 'NBU' | 'manual';
    date: number;
    comment?: string;
  },
  operationKey: string,
): Promise<{ transaction: Row; created: boolean }> {
  if (input.fromCardId === input.toCardId) {
    throw AppError.badRequest('Source and destination cards must differ.');
  }
  const markerRef = telegramOperationMarkerRef(uid, `transfer:${operationKey}`);
  const transactionRef = telegramTransactionRef(`transfer:${uid}:${operationKey}`, 'telegram_transfer_');

  return db.runTransaction(async (tx) => {
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      const existing = await tx.get(transactionRef);
      if (!existing.exists) throw new Error('Telegram transfer marker has no transaction.');
      return { transaction: { id: existing.id, ...existing.data() }, created: false };
    }

    const from = await readOwned(tx, cardsCol().doc(input.fromCardId), uid, 'Source card not found.');
    const to = await readOwned(tx, cardsCol().doc(input.toCardId), uid, 'Destination card not found.');
    const differentCurrencies = from.data.currency !== to.data.currency;
    const toAmount = differentCurrencies ? input.toAmount : (input.toAmount ?? input.amount);
    if (!toAmount || toAmount <= 0) {
      throw AppError.badRequest('A destination amount is required for a cross-currency transfer.');
    }

    const now = Date.now();
    const doc = {
      type: 'expense',
      amount: input.amount,
      currency: from.data.currency,
      categoryId: '',
      cardId: input.fromCardId,
      toCardId: input.toCardId,
      toAmount,
      toCurrency: to.data.currency,
      source: 'transfer',
      sourceLabel: `Transfer: ${from.data.name} -> ${to.data.name}`,
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.baseAmount ? { baseAmount: input.baseAmount } : {}),
      ...(input.fxRate ? { fxRate: input.fxRate } : {}),
      ...(input.fxRateSource ? { fxRateSource: input.fxRateSource } : {}),
      date: input.date,
      origin: 'telegram',
      userId: uid,
      createdAt: now,
    };

    tx.create(transactionRef, doc);
    tx.update(from.ref, { balance: FieldValue.increment(balanceDelta(from.data.cardType, 'expense', input.amount)) });
    tx.update(to.ref, { balance: FieldValue.increment(balanceDelta(to.data.cardType, 'income', toAmount)) });
    tx.create(markerRef, {
      userId: uid,
      operationKey,
      kind: 'transfer',
      transactionId: transactionRef.id,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86_400_000),
    });
    return { transaction: { id: transactionRef.id, ...doc }, created: true };
  });
}

/** Refund (partial or full) an existing transaction, capped at its remaining returnable amount. */
export async function returnTransaction(
  uid: string,
  originalId: string,
  input: { returnAmount: number; accountId?: string; date?: number; comment?: string },
): Promise<Row> {
  return db.runTransaction(async (tx) => {
    const original = await readOwned(tx, txnsCol().doc(originalId), uid, 'Original transaction not found.');
    const o = original.data;
    if (o.type !== 'expense' || (o.source && o.source !== 'subscription')) {
      throw AppError.badRequest('Only an expense can be returned.');
    }
    const remaining = (o.amount as number) - (o.returnedAmount ?? 0);
    if (input.returnAmount > remaining) {
      throw AppError.badRequest('Return amount exceeds the remaining returnable amount.', { remaining });
    }

    const account = input.accountId
      ? await readOwned(tx, cardsCol().doc(input.accountId), uid, 'Card not found.')
      : null;
    if (account && account.data.currency !== o.currency) {
      throw AppError.badRequest('Return account currency must match the original transaction currency.');
    }

    const ref = newTxnRef();
    const doc = {
      type: 'income',
      amount: input.returnAmount,
      currency: o.currency,
      categoryId: o.categoryId,
      ...(o.subcategoryId ? { subcategoryId: o.subcategoryId } : {}),
      cardId: input.accountId,
      source: 'return',
      sourceLabel: 'Return',
      linkedTransactionId: originalId,
      ...(input.comment ? { comment: input.comment } : {}),
      ...returnFxFields(o, input.returnAmount),
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
