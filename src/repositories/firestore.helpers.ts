import { db } from '../config/firebase';
import { AppError } from '../utils/AppError';

export const cardsCol = () => db.collection('cards');
export const txnsCol = () => db.collection('transactions');
export const depositsCol = () => db.collection('deposits');
export const debtsCol = () => db.collection('debts');
export const subscriptionsCol = () => db.collection('subscriptions');
export const savingsGoalsCol = () => db.collection('savingsGoals');

export interface OwnedDoc {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
}

/** Read a doc inside a transaction, asserting it exists and belongs to `uid`. */
export async function readOwned(
  tx: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  uid: string,
  notFoundMsg = 'Resource not found.',
): Promise<OwnedDoc> {
  const snap = await tx.get(ref);
  if (!snap.exists) throw AppError.notFound(notFoundMsg);
  const data = snap.data()!;
  if (data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
  return { ref, data };
}

/** Like `readOwned` but returns null when the doc is missing (still 403 on wrong owner). */
export async function tryReadOwned(
  tx: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  uid: string,
): Promise<OwnedDoc | null> {
  const snap = await tx.get(ref);
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
  return { ref, data };
}

export const newTxnRef = () => txnsCol().doc();
