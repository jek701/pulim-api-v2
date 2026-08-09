import { createHash } from 'node:crypto';
import { db, FieldValue, Timestamp } from '../config/firebase';
import { balanceDelta } from '../domain/balance';
import { calcDebtTotal } from '../domain/debt';
import { cardsCol, debtsCol, newTxnRef, readOwned } from '../repositories/firestore.helpers';
import { telegramOperationMarkerRef, telegramTransactionRef } from './transaction.service';
import type { Commission } from '../domain/types';

type Row = Record<string, any>;

interface CreateDebtInput {
  direction: 'i_owe' | 'owe_me';
  person: string;
  amount: number;
  currency: string;
  commission?: Commission;
  dueDate?: number;
  comment?: string;
  accountId?: string;
}

export interface TelegramDebtInput extends CreateDebtInput {
  date?: number;
}

/** Create a debt and, if an account is chosen, record the initial cash movement atomically. */
export async function createDebt(uid: string, input: CreateDebtInput): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const account = input.accountId
      ? await readOwned(tx, cardsCol().doc(input.accountId), uid, 'Account not found.')
      : null;

    const debtRef = debtsCol().doc();
    const debtDoc = {
      direction: input.direction,
      person: input.person,
      amount: input.amount,
      paidAmount: 0,
      currency: input.currency,
      commission: input.commission,
      dueDate: input.dueDate,
      comment: input.comment,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      isPaid: false,
      userId: uid,
      createdAt: now,
    };
    tx.set(debtRef, debtDoc);

    if (account) {
      // i_owe: you receive money now (income). owe_me: you hand money out (expense).
      const txType = input.direction === 'i_owe' ? 'income' : 'expense';
      const ref = newTxnRef();
      tx.set(ref, {
        type: txType, amount: input.amount, currency: input.currency, categoryId: '',
        source: 'debt_payment', sourceLabel: `Debt: ${input.person}`,
        debtId: debtRef.id, cardId: account.ref.id, date: now, userId: uid, createdAt: now,
      });
      tx.update(account.ref, {
        balance: FieldValue.increment(balanceDelta(account.data.cardType, txType, input.amount)),
      });
    }
    return { id: debtRef.id, ...debtDoc };
  });
}

/** Idempotent Telegram debt creation. A debt and its optional initial cash
 * movement are committed together and can safely be retried by Telegram. */
export async function createTelegramDebtOnce(
  uid: string,
  input: TelegramDebtInput,
  operationKey: string,
): Promise<{ debt: Row; created: boolean; transactionId?: string }> {
  const markerRef = telegramOperationMarkerRef(uid, `debt:${operationKey}`);
  const debtRef = db.collection('debts').doc(
    `telegram_${createHash('sha256').update(`${uid}:${operationKey}`).digest('hex').slice(0, 40)}`,
  );
  const transactionRef = telegramTransactionRef(`debt:${uid}:${operationKey}`, 'telegram_debt_');

  return db.runTransaction(async (tx) => {
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      const existing = await tx.get(debtRef);
      if (!existing.exists) throw new Error('Telegram debt marker has no debt.');
      return {
        debt: { id: existing.id, ...existing.data() },
        created: false,
        ...(existing.data()?.accountId ? { transactionId: transactionRef.id } : {}),
      };
    }

    const account = input.accountId
      ? await readOwned(tx, cardsCol().doc(input.accountId), uid, 'Account not found.')
      : null;
    const now = Date.now();
    const debtDoc = {
      direction: input.direction,
      person: input.person,
      amount: input.amount,
      paidAmount: 0,
      currency: input.currency,
      ...(input.commission ? { commission: input.commission } : {}),
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      isPaid: false,
      origin: 'telegram',
      userId: uid,
      createdAt: now,
    };
    tx.create(debtRef, debtDoc);

    let transactionId: string | undefined;
    if (account) {
      const txType = input.direction === 'i_owe' ? 'income' : 'expense';
      const transactionDoc = {
        type: txType,
        amount: input.amount,
        currency: input.currency,
        categoryId: '',
        source: 'debt_payment',
        sourceLabel: `Debt: ${input.person}`,
        debtId: debtRef.id,
        origin: 'telegram',
        cardId: account.ref.id,
        date: input.date ?? now,
        userId: uid,
        createdAt: now,
      };
      tx.create(transactionRef, transactionDoc);
      tx.update(account.ref, {
        balance: FieldValue.increment(balanceDelta(account.data.cardType, txType, input.amount)),
      });
      transactionId = transactionRef.id;
    }

    tx.create(markerRef, {
      userId: uid,
      operationKey,
      kind: 'debt',
      debtId: debtRef.id,
      ...(transactionId ? { transactionId } : {}),
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86_400_000),
    });
    return { debt: { id: debtRef.id, ...debtDoc }, created: true, transactionId };
  });
}

/** Record a (partial) debt payment, auto-completing when paid amount reaches the commission-adjusted total. */
export async function payDebt(uid: string, debtId: string, amount: number, accountId?: string): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const debt = await readOwned(tx, debtsCol().doc(debtId), uid, 'Debt not found.');
    const account = accountId ? await readOwned(tx, cardsCol().doc(accountId), uid, 'Account not found.') : null;

    const total = calcDebtTotal(debt.data.amount, debt.data.commission);
    const newPaid = (debt.data.paidAmount || 0) + amount;
    // owe_me: they repay you (income). i_owe: you repay them (expense).
    const txType = debt.data.direction === 'owe_me' ? 'income' : 'expense';

    const patch: Record<string, unknown> = { paidAmount: FieldValue.increment(amount) };
    if (newPaid >= total) patch.isPaid = true;
    tx.update(debt.ref, patch);

    const ref = newTxnRef();
    tx.set(ref, {
      type: txType, amount, currency: debt.data.currency, categoryId: '',
      source: 'debt_payment', sourceLabel: `Debt: ${debt.data.person}`,
      ...(accountId ? { cardId: accountId } : {}), date: now, userId: uid, createdAt: now,
    });
    if (account) {
      tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, txType, amount)) });
    }
    return { id: debtId, paidAmount: newPaid, isPaid: newPaid >= total, total };
  });
}

/** Idempotent Telegram debt payment with an optional balance movement. */
export async function payTelegramDebtOnce(
  uid: string,
  input: { debtId: string; amount: number; accountId?: string; date?: number; comment?: string },
  operationKey: string,
): Promise<{ debtId: string; person: string; direction: 'i_owe' | 'owe_me'; currency: string; amount: number; paidAmount: number; total: number; isPaid: boolean; transactionId?: string; created: boolean }> {
  const markerRef = telegramOperationMarkerRef(uid, `debt_payment:${operationKey}`);
  const transactionRef = telegramTransactionRef(`debt_payment:${uid}:${operationKey}`, 'telegram_debt_payment_');

  return db.runTransaction(async (tx) => {
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      const debt = await readOwned(tx, debtsCol().doc(input.debtId), uid, 'Debt not found.');
      return {
        debtId: input.debtId,
        person: debt.data.person,
        direction: debt.data.direction,
        currency: debt.data.currency,
        amount: input.amount,
        paidAmount: Number(debt.data.paidAmount ?? 0),
        total: calcDebtTotal(debt.data.amount, debt.data.commission),
        isPaid: Boolean(debt.data.isPaid),
        ...(input.accountId ? { transactionId: transactionRef.id } : {}),
        created: false,
      };
    }

    const debt = await readOwned(tx, debtsCol().doc(input.debtId), uid, 'Debt not found.');
    const total = calcDebtTotal(debt.data.amount, debt.data.commission);
    const paidAmount = Number(debt.data.paidAmount ?? 0);
    const remaining = Math.max(0, total - paidAmount);
    if (debt.data.isPaid || remaining <= 0) throw new Error('Debt is already paid.');
    if (input.amount > remaining) throw new Error('Debt payment exceeds remaining amount.');
    const account = input.accountId
      ? await readOwned(tx, cardsCol().doc(input.accountId), uid, 'Account not found.')
      : null;
    const now = Date.now();
    const newPaid = paidAmount + input.amount;
    const isPaid = newPaid >= total;
    tx.update(debt.ref, { paidAmount: newPaid, isPaid });

    let transactionId: string | undefined;
    if (account) {
      const txType = debt.data.direction === 'owe_me' ? 'income' : 'expense';
      const transactionDoc = {
        type: txType,
        amount: input.amount,
        currency: debt.data.currency,
        categoryId: '',
        source: 'debt_payment',
        sourceLabel: `Debt: ${debt.data.person}`,
        debtId: input.debtId,
        origin: 'telegram',
        cardId: account.ref.id,
        ...(input.comment ? { comment: input.comment } : {}),
        date: input.date ?? now,
        userId: uid,
        createdAt: now,
      };
      tx.create(transactionRef, transactionDoc);
      tx.update(account.ref, {
        balance: FieldValue.increment(balanceDelta(account.data.cardType, txType, input.amount)),
      });
      transactionId = transactionRef.id;
    }

    tx.create(markerRef, {
      userId: uid,
      operationKey,
      kind: 'debt_payment',
      debtId: input.debtId,
      ...(transactionId ? { transactionId } : {}),
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 30 * 86_400_000),
    });
    return {
      debtId: input.debtId,
      person: debt.data.person,
      direction: debt.data.direction,
      currency: debt.data.currency,
      amount: input.amount,
      paidAmount: newPaid,
      total,
      isPaid,
      ...(transactionId ? { transactionId } : {}),
      created: true,
    };
  });
}
