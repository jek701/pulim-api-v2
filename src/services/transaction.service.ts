import {
  Timestamp,
  documentKey,
  filterQuery,
  patchValue,
  queryTable,
  readDocument,
  runSqlTransaction,
  writeBatch,
} from '../db/documents';
import { createHash } from 'node:crypto';
import { AppError } from '../utils/AppError';
import { balanceDelta } from '../domain/balance';
import {
  cardsCol,
  txnsCol,
  readOwned,
  resolveCreateTarget,
  takeClientId,
  tryReadOwned,
  writeCreated,
  type OwnedDoc,
} from '../repositories/sql.helpers';
import { scheduleBudgetCheck } from '../notifications/queue.repository';
import { logger } from '../utils/logger';
type Row = Record<string, any>;
function queueBudgetCheck(uid: string): void {
  void scheduleBudgetCheck(uid).catch((error) =>
    logger.warn({ err: error, uid }, 'notify.budget_schedule.failed'),
  );
}
export function telegramOperationMarkerRef(uid: string, operationKey: string) {
  return documentKey(
    queryTable('telegramOperations'),
    createHash('sha256').update(`${uid}:${operationKey}`).digest('hex'),
  );
}
export function telegramTransactionRef(operationKey: string, prefix = 'telegram_') {
  const digest = createHash('sha256').update(operationKey).digest('hex').slice(0, 40);
  return documentKey(txnsCol(), `${prefix}${digest}`);
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
): Promise<{
  transaction: Row;
  created: boolean;
}> {
  if (!input.categoryId) throw AppError.badRequest('A category is required.');
  if (
    input.currency !== 'UZS' &&
    (!input.baseAmount || !input.fxRate || input.fxRateSource !== 'NBU')
  ) {
    throw AppError.badRequest('An NBU exchange-rate snapshot is required for foreign currency.');
  }
  const markerRef = telegramOperationMarkerRef(uid, operationKey);
  const transactionRef = telegramTransactionRef(`${uid}:${operationKey}`);
  const draftRef = draftId ? documentKey(queryTable('telegramDrafts'), draftId) : null;
  const result = await runSqlTransaction(async (tx) => {
    const marker = await tx.read(markerRef);
    if (marker.exists) {
      const existing = await tx.read(transactionRef);
      if (!existing.exists) throw new Error('Telegram operation marker has no transaction.');
      return { transaction: { id: existing.id, ...existing.data }, created: false };
    }
    const draft = draftRef ? await readOwned(tx, draftRef, uid, 'Telegram draft not found.') : null;
    if (draft && !['pending', 'waiting_fx'].includes(String(draft.data.status))) {
      if (draft.data.transactionId) {
        const existing = await tx.read(documentKey(txnsCol(), String(draft.data.transactionId)));
        if (existing.exists)
          return { transaction: { id: existing.id, ...existing.data }, created: false };
      }
      throw AppError.badRequest('Telegram draft is no longer pending.');
    }
    await readOwned(
      tx,
      documentKey(queryTable('categories'), String(input.categoryId)),
      uid,
      'Category not found.',
    );
    if (input.subcategoryId) {
      const subcategory = await readOwned(
        tx,
        documentKey(queryTable('subcategories'), String(input.subcategoryId)),
        uid,
        'Subcategory not found.',
      );
      if (subcategory.data.categoryId !== input.categoryId) {
        throw AppError.badRequest('Subcategory does not belong to the selected category.');
      }
    }
    const card = input.cardId
      ? await readOwned(tx, documentKey(cardsCol(), input.cardId), uid, 'Card not found.')
      : null;
    const now = Date.now();
    const doc = { ...input, origin: 'telegram', userId: uid, createdAt: now };
    tx.insert(transactionRef, doc);
    if (card) {
      const delta = balanceDelta(card.data.cardType, input.type, input.amount);
      tx.patch(card.ref, { balance: patchValue.increment(delta) });
    }
    if (draftRef) {
      tx.save(
        draftRef,
        {
          status: 'confirmed',
          transactionId: transactionRef.id,
          updatedAt: now,
        },
        { merge: true },
      );
    }
    tx.insert(markerRef, {
      userId: uid,
      operationKey,
      transactionId: transactionRef.id,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86400000),
    });
    return { transaction: { id: transactionRef.id, ...doc }, created: true };
  });
  queueBudgetCheck(uid);
  return result;
}
/** Create a transaction and, if it references a card, adjust that card's balance atomically. */
export async function createTransaction(uid: string, payload: Row): Promise<Row> {
  const { clientId, fields: input } = takeClientId(payload);
  const result = await runSqlTransaction(async (tx) => {
    // Offline replay of an existing own transaction: return it, no second balance effect.
    const target = await resolveCreateTarget(tx, txnsCol(), uid, clientId);
    if (target.existing) return target.existing;
    const card = input.cardId
      ? await readOwned(tx, documentKey(cardsCol(), input.cardId), uid, 'Card not found.')
      : null;
    const ref = target.ref;
    const doc = { ...input, userId: uid, createdAt: Date.now() };
    writeCreated(tx, target, doc);
    if (card) {
      const delta = balanceDelta(card.data.cardType, input.type, input.amount);
      tx.patch(card.ref, { balance: patchValue.increment(delta) });
    }
    return { id: ref.id, ...doc };
  });
  queueBudgetCheck(uid);
  return result;
}
/** Edit a transaction: atomically revert the old balance impact and apply the new one. */
export async function updateTransaction(uid: string, id: string, patch: Row): Promise<Row> {
  const result = await runSqlTransaction(async (tx) => {
    const original = await readOwned(tx, documentKey(txnsCol(), id), uid, 'Transaction not found.');
    const old = original.data;
    if (old.scope === 'household') {
      throw AppError.badRequest('Edit this operation from the family space.');
    }
    if (old.source) {
      throw AppError.badRequest('This operation must be edited through its dedicated endpoint.', {
        source: old.source,
      });
    }
    const merged = { ...old, ...patch };
    const categoryChanged =
      typeof patch.categoryId === 'string' && patch.categoryId !== old.categoryId;
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
    const linkedRefunds =
      (old.returnedAmount ?? 0) > 0
        ? await tx.read(
            filterQuery(
              filterQuery(txnsCol(), 'userId', '==', uid),
              'linkedTransactionId',
              '==',
              id,
            ),
          )
        : null;
    const oldCardId: string | undefined = old.cardId;
    const newCardId: string | undefined = merged.cardId;
    // All reads first.
    const oldCard = oldCardId
      ? await tryReadOwned(tx, documentKey(cardsCol(), oldCardId), uid)
      : null;
    const newCard =
      newCardId && newCardId === oldCardId
        ? oldCard
        : newCardId
          ? await tryReadOwned(tx, documentKey(cardsCol(), newCardId), uid)
          : null;
    // Then writes.
    if (oldCard && newCard && oldCardId === newCardId) {
      const net =
        -balanceDelta(oldCard.data.cardType, old.type, old.amount) +
        balanceDelta(oldCard.data.cardType, merged.type, merged.amount);
      if (net !== 0) tx.patch(oldCard.ref, { balance: patchValue.increment(net) });
    } else {
      if (oldCard) {
        tx.patch(oldCard.ref, {
          balance: patchValue.increment(-balanceDelta(oldCard.data.cardType, old.type, old.amount)),
        });
      }
      if (newCard) {
        tx.patch(newCard.ref, {
          balance: patchValue.increment(
            balanceDelta(newCard.data.cardType, merged.type, merged.amount),
          ),
        });
      }
    }
    const writePatch = { ...patch };
    if (categoryChanged && !patch.subcategoryId) {
      writePatch.subcategoryId = patchValue.delete();
    }
    tx.save(original.ref, writePatch, { merge: true });
    if (categoryChanged && linkedRefunds) {
      for (const linked of linkedRefunds.rows) {
        tx.save(
          linked.key,
          {
            categoryId: merged.categoryId,
            subcategoryId: merged.subcategoryId ?? patchValue.delete(),
          },
          { merge: true },
        );
      }
    }
    return { id, ...merged };
  });
  queueBudgetCheck(uid);
  return result;
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
  return runSqlTransaction(async (tx) => {
    const original = await readOwned(tx, documentKey(txnsCol(), id), uid, 'Transfer not found.');
    const old = original.data;
    if (old.source !== 'transfer' || !old.cardId || !old.toCardId) {
      throw AppError.badRequest('Transaction is not a transfer.');
    }
    // Firestore requires every read to happen before the first write.
    const ids = new Set<string>([old.cardId, old.toCardId, input.fromCardId, input.toCardId]);
    const cards = new Map<string, OwnedDoc>();
    for (const cardId of ids) {
      cards.set(
        cardId,
        await readOwned(tx, documentKey(cardsCol(), cardId), uid, 'Card not found.'),
      );
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
      if (delta !== 0) tx.patch(cards.get(cardId)!.ref, { balance: patchValue.increment(delta) });
    }
    // Replace the document so stale category/subcategory or normal-transaction
    // fields cannot survive an earlier broken edit.
    tx.save(original.ref, doc);
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
  const result = await runSqlTransaction(async (tx) => {
    const refund = await readOwned(tx, documentKey(txnsCol(), id), uid, 'Return not found.');
    const old = refund.data;
    if (old.source !== 'return' || !old.linkedTransactionId) {
      throw AppError.badRequest('Transaction is not a return.');
    }
    const original = await readOwned(
      tx,
      documentKey(txnsCol(), old.linkedTransactionId),
      uid,
      'Original transaction not found.',
    );
    const purchase = original.data;
    const oldAccount = old.cardId
      ? await tryReadOwned(tx, documentKey(cardsCol(), old.cardId), uid)
      : null;
    const newAccount = input.accountId
      ? input.accountId === old.cardId
        ? oldAccount
        : await readOwned(tx, documentKey(cardsCol(), input.accountId), uid, 'Card not found.')
      : null;
    if (newAccount && newAccount.data.currency !== purchase.currency) {
      throw AppError.badRequest(
        'Return account currency must match the original transaction currency.',
      );
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
      if (net !== 0) tx.patch(oldAccount.ref, { balance: patchValue.increment(net) });
    } else {
      if (oldAccount) {
        tx.patch(oldAccount.ref, {
          balance: patchValue.increment(
            -balanceDelta(oldAccount.data.cardType, 'income', old.amount),
          ),
        });
      }
      if (newAccount) {
        tx.patch(newAccount.ref, {
          balance: patchValue.increment(
            balanceDelta(newAccount.data.cardType, 'income', input.returnAmount),
          ),
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
    tx.patch(original.ref, { returnedAmount: otherReturned + input.returnAmount });
    tx.save(refund.ref, doc);
    return { id, ...doc };
  });
  queueBudgetCheck(uid);
  return result;
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
  await runSqlTransaction(async (tx) => {
    const { ref, data } = await readOwned(
      tx,
      documentKey(txnsCol(), id),
      uid,
      'Transaction not found.',
    );
    if (data.scope === 'household') {
      throw AppError.badRequest('Delete this operation from the family space.');
    }
    // ---- reads first (Firestore transactions forbid reads after writes) ----
    // Equality-only filters, so single-field indexes are enough — no composite index.
    const linkedSnap = await tx.read(
      filterQuery(filterQuery(txnsCol(), 'userId', '==', uid), 'linkedTransactionId', '==', id),
    );
    const linked = linkedSnap.rows.map((d) => ({ ref: d.key, data: d.data }));
    // Cards are deduped by id: two refunds to the same card must not each read it.
    const cardIds = new Set<string>();
    if (data.cardId) cardIds.add(data.cardId);
    if (data.source === 'transfer' && data.toCardId) cardIds.add(data.toCardId);
    for (const l of linked) if (l.data.cardId) cardIds.add(l.data.cardId);
    const cards = new Map<string, OwnedDoc | null>();
    for (const cardId of cardIds) {
      cards.set(cardId, await tryReadOwned(tx, documentKey(cardsCol(), cardId), uid));
    }
    const originalRef =
      data.source === 'return' && data.linkedTransactionId
        ? documentKey(txnsCol(), data.linkedTransactionId)
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
      tx.remove(l.ref);
    }
    if (original) {
      tx.patch(original.ref, { returnedAmount: patchValue.increment(-data.amount) });
    }
    for (const [cardId, delta] of balanceChanges) {
      const card = cards.get(cardId);
      if (card) tx.patch(card.ref, { balance: patchValue.increment(delta) });
    }
    tx.remove(ref);
  });
  queueBudgetCheck(uid);
}
/**
 * Delete ALL of a user's transactions (the Settings "clear data" action).
 * Matches the frontend: a bulk wipe that does NOT reverse card balances.
 */
export async function clearAllTransactions(uid: string): Promise<{
  deleted: number;
}> {
  const snap = await readDocument(filterQuery(txnsCol(), 'userId', '==', uid));
  const personal = snap.rows.filter((doc) => doc.data.scope !== 'household');
  for (let index = 0; index < personal.length; index += 400) {
    const batch = writeBatch();
    personal.slice(index, index + 400).forEach((doc) => batch.remove(doc.key));
    await batch.commit();
  }
  return { deleted: personal.length };
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
    /** Optional offline client id of the new transfer transaction. */
    id?: string;
  },
): Promise<Row> {
  if (input.fromCardId === input.toCardId) {
    throw AppError.badRequest('Cannot transfer to the same card.');
  }
  return runSqlTransaction(async (tx) => {
    const target = await resolveCreateTarget(tx, txnsCol(), uid, input.id);
    if (target.existing) return target.existing;
    const from = await readOwned(
      tx,
      documentKey(cardsCol(), input.fromCardId),
      uid,
      'Source card not found.',
    );
    const to = await readOwned(
      tx,
      documentKey(cardsCol(), input.toCardId),
      uid,
      'Destination card not found.',
    );
    const differentCurrencies = from.data.currency !== to.data.currency;
    const toAmt = differentCurrencies ? input.toAmount : (input.toAmount ?? input.amount);
    if (!toAmt || toAmt <= 0) {
      throw AppError.badRequest('toAmount is required (and > 0) for cross-currency transfers.');
    }
    const ref = target.ref;
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
    writeCreated(tx, target, doc);
    tx.patch(from.ref, {
      balance: patchValue.increment(balanceDelta(from.data.cardType, 'expense', input.amount)),
    });
    tx.patch(to.ref, {
      balance: patchValue.increment(balanceDelta(to.data.cardType, 'income', toAmt)),
    });
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
): Promise<{
  transaction: Row;
  created: boolean;
}> {
  if (input.fromCardId === input.toCardId) {
    throw AppError.badRequest('Source and destination cards must differ.');
  }
  const markerRef = telegramOperationMarkerRef(uid, `transfer:${operationKey}`);
  const transactionRef = telegramTransactionRef(
    `transfer:${uid}:${operationKey}`,
    'telegram_transfer_',
  );
  return runSqlTransaction(async (tx) => {
    const marker = await tx.read(markerRef);
    if (marker.exists) {
      const existing = await tx.read(transactionRef);
      if (!existing.exists) throw new Error('Telegram transfer marker has no transaction.');
      return { transaction: { id: existing.id, ...existing.data }, created: false };
    }
    const from = await readOwned(
      tx,
      documentKey(cardsCol(), input.fromCardId),
      uid,
      'Source card not found.',
    );
    const to = await readOwned(
      tx,
      documentKey(cardsCol(), input.toCardId),
      uid,
      'Destination card not found.',
    );
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
    tx.insert(transactionRef, doc);
    tx.patch(from.ref, {
      balance: patchValue.increment(balanceDelta(from.data.cardType, 'expense', input.amount)),
    });
    tx.patch(to.ref, {
      balance: patchValue.increment(balanceDelta(to.data.cardType, 'income', toAmount)),
    });
    tx.insert(markerRef, {
      userId: uid,
      operationKey,
      kind: 'transfer',
      transactionId: transactionRef.id,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86400000),
    });
    return { transaction: { id: transactionRef.id, ...doc }, created: true };
  });
}
/** Refund (partial or full) an existing transaction, capped at its remaining returnable amount. */
export async function returnTransaction(
  uid: string,
  originalId: string,
  input: {
    returnAmount: number;
    accountId?: string;
    date?: number;
    comment?: string;
    /** Optional offline client id of the new refund transaction. */
    id?: string;
  },
): Promise<Row> {
  const result = await runSqlTransaction(async (tx) => {
    // Checked first: a replayed full refund must not fail the "remaining" check.
    const target = await resolveCreateTarget(tx, txnsCol(), uid, input.id);
    if (target.existing) return target.existing;
    const original = await readOwned(
      tx,
      documentKey(txnsCol(), originalId),
      uid,
      'Original transaction not found.',
    );
    const o = original.data;
    if (o.type !== 'expense' || (o.source && o.source !== 'subscription')) {
      throw AppError.badRequest('Only an expense can be returned.');
    }
    const remaining = (o.amount as number) - (o.returnedAmount ?? 0);
    if (input.returnAmount > remaining) {
      throw AppError.badRequest('Return amount exceeds the remaining returnable amount.', {
        remaining,
      });
    }
    const account = input.accountId
      ? await readOwned(tx, documentKey(cardsCol(), input.accountId), uid, 'Card not found.')
      : null;
    if (account && account.data.currency !== o.currency) {
      throw AppError.badRequest(
        'Return account currency must match the original transaction currency.',
      );
    }
    const ref = target.ref;
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
    writeCreated(tx, target, doc);
    tx.patch(original.ref, { returnedAmount: patchValue.increment(input.returnAmount) });
    if (account) {
      tx.patch(account.ref, {
        balance: patchValue.increment(
          balanceDelta(account.data.cardType, 'income', input.returnAmount),
        ),
      });
    }
    return { id: ref.id, ...doc };
  });
  queueBudgetCheck(uid);
  return result;
}
