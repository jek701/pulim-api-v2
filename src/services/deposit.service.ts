import { db, FieldValue } from '../config/firebase';
import { AppError } from '../utils/AppError';
import { balanceDelta } from '../domain/balance';
import { calcCurrentPrincipal, calcRemainingInterest } from '../domain/deposit';
import { cardsCol, depositsCol, newTxnRef, readOwned } from '../repositories/firestore.helpers';
import type { Deposit } from '../domain/types';

type Row = Record<string, any>;
const asDeposit = (id: string, data: FirebaseFirestore.DocumentData): Deposit =>
  ({ id, ...(data as Omit<Deposit, 'id'>) });

/** Collect accrued (uncollected) interest into the configured destination account. */
export async function collectInterest(uid: string, depositId: string): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const dep = await readOwned(tx, depositsCol().doc(depositId), uid, 'Deposit not found.');
    if (dep.data.isClosed) throw AppError.badRequest('Deposit is closed.');
    if (!dep.data.interestToAccountId) throw AppError.badRequest('No interest destination account set.');
    const account = await readOwned(tx, cardsCol().doc(dep.data.interestToAccountId), uid, 'Destination account not found.');

    const amount = calcRemainingInterest(asDeposit(depositId, dep.data), now);
    if (amount <= 0) throw AppError.badRequest('No interest available to collect.');

    const ref = newTxnRef();
    const doc = {
      type: 'income', amount, currency: dep.data.currency, categoryId: '',
      source: 'deposit_interest', sourceLabel: `Interest: ${dep.data.bank}`,
      cardId: dep.data.interestToAccountId, date: now, userId: uid, createdAt: now,
    };
    tx.set(ref, doc);
    tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, 'income', amount)) });
    tx.update(dep.ref, { interestPaidOut: FieldValue.increment(amount), lastInterestPaidAt: now });
    return { collected: amount, transaction: { id: ref.id, ...doc } };
  });
}

/** Close a deposit, paying principal + remaining interest into an account. */
export async function closeDeposit(uid: string, depositId: string, accountId: string): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const dep = await readOwned(tx, depositsCol().doc(depositId), uid, 'Deposit not found.');
    if (dep.data.isClosed) throw AppError.badRequest('Deposit already closed.');
    const account = await readOwned(tx, cardsCol().doc(accountId), uid, 'Account not found.');

    const d = asDeposit(depositId, dep.data);
    const total = calcCurrentPrincipal(d) + calcRemainingInterest(d, now);

    const ref = newTxnRef();
    const doc = {
      type: 'income', amount: total, currency: dep.data.currency, categoryId: '',
      source: 'deposit_close', sourceLabel: `Deposit closed: ${dep.data.bank}`,
      cardId: accountId, date: now, userId: uid, createdAt: now,
    };
    tx.set(ref, doc);
    tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, 'income', total)) });
    tx.update(dep.ref, { isClosed: true, closedAt: now });
    return { total, transaction: { id: ref.id, ...doc } };
  });
}

/** Top up the principal from an account (records a tranche + expense transaction). */
export async function replenishDeposit(uid: string, depositId: string, accountId: string, amount: number): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const dep = await readOwned(tx, depositsCol().doc(depositId), uid, 'Deposit not found.');
    if (dep.data.isClosed) throw AppError.badRequest('Deposit is closed.');
    if (!dep.data.isReplenishable) throw AppError.badRequest('Deposit is not replenishable.');
    const account = await readOwned(tx, cardsCol().doc(accountId), uid, 'Account not found.');
    if (account.data.cardType !== 'credit' && amount > account.data.balance) {
      throw AppError.badRequest('Insufficient balance on the source account.');
    }

    const ref = newTxnRef();
    const doc = {
      type: 'expense', amount, currency: dep.data.currency, categoryId: '',
      source: 'deposit_replenish', sourceLabel: `Top-up: ${dep.data.bank}`,
      cardId: accountId, date: now, userId: uid, createdAt: now,
    };
    tx.set(ref, doc);
    tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, 'expense', amount)) });
    tx.update(dep.ref, { tranches: FieldValue.arrayUnion({ amount, date: now }) });
    return { transaction: { id: ref.id, ...doc } };
  });
}

/** Withdraw from the principal into an account (negative tranche + income transaction). */
export async function withdrawDeposit(uid: string, depositId: string, accountId: string, amount: number): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const dep = await readOwned(tx, depositsCol().doc(depositId), uid, 'Deposit not found.');
    if (dep.data.isClosed) throw AppError.badRequest('Deposit is closed.');
    const account = await readOwned(tx, cardsCol().doc(accountId), uid, 'Account not found.');

    const principal = calcCurrentPrincipal(asDeposit(depositId, dep.data));
    if (amount > principal) throw AppError.badRequest('Withdrawal exceeds current principal.', { principal });

    const ref = newTxnRef();
    const doc = {
      type: 'income', amount, currency: dep.data.currency, categoryId: '',
      source: 'deposit_withdraw', sourceLabel: `Withdrawal: ${dep.data.bank}`,
      cardId: accountId, date: now, userId: uid, createdAt: now,
    };
    tx.set(ref, doc);
    tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, 'income', amount)) });
    tx.update(dep.ref, { tranches: FieldValue.arrayUnion({ amount: -amount, date: now }) });
    return { transaction: { id: ref.id, ...doc } };
  });
}
