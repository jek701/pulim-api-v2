import {
  DocumentData,
  DocumentKey,
  SqlTransaction,
  documentKey,
  queryTable,
} from '../db/documents';
import { AppError } from '../utils/AppError';
export const cardsCol = () => queryTable('cards');
export const txnsCol = () => queryTable('transactions');
export const depositsCol = () => queryTable('deposits');
export const debtsCol = () => queryTable('debts');
export const subscriptionsCol = () => queryTable('subscriptions');
export const savingsGoalsCol = () => queryTable('savingsGoals');
export interface OwnedDoc {
  ref: DocumentKey;
  data: DocumentData;
}
/** Read a doc inside a transaction, asserting it exists and belongs to `uid`. */
export async function readOwned(
  tx: SqlTransaction,
  ref: DocumentKey,
  uid: string,
  notFoundMsg = 'Resource not found.',
): Promise<OwnedDoc> {
  const snap = await tx.read(ref);
  if (!snap.exists) throw AppError.notFound(notFoundMsg);
  const data = snap.data!;
  if (data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
  return { ref, data };
}
/** Like `readOwned` but returns null when the doc is missing (still 403 on wrong owner). */
export async function tryReadOwned(
  tx: SqlTransaction,
  ref: DocumentKey,
  uid: string,
): Promise<OwnedDoc | null> {
  const snap = await tx.read(ref);
  if (!snap.exists) return null;
  const data = snap.data!;
  if (data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
  return { ref, data };
}
export const newTxnRef = () => documentKey(txnsCol());
