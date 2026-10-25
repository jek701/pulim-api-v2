import {
  DocumentData,
  DocumentKey,
  QuerySpec,
  SqlTransaction,
  documentKey,
  queryTable,
} from '../db/documents';
import { AppError } from '../utils/AppError';
import { isValidClientId } from '../domain/clientId';
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

/**
 * Where a create writes its document. `existing` is set when an offline client
 * replays a create whose id already holds one of the caller's own documents: the
 * caller must then return it unchanged and write nothing (no second balance effect).
 */
export interface CreateTarget {
  ref: DocumentKey;
  /** True when the id came from the client (write with `tx.insert`). */
  clientSupplied: boolean;
  existing: ({ id: string } & DocumentData) | null;
}

/**
 * Resolve the key of a new document inside a transaction. Must run before the
 * transaction's first write. Without `clientId` a server id is generated (no read).
 * With one: missing -> write there; own -> replay; anyone else's -> 409 ID_CONFLICT
 * (same answer for every foreign owner, including households).
 */
export async function resolveCreateTarget(
  tx: SqlTransaction,
  collection: QuerySpec,
  uid: string,
  clientId: unknown,
): Promise<CreateTarget> {
  if (clientId === undefined || clientId === null) {
    return { ref: documentKey(collection), clientSupplied: false, existing: null };
  }
  if (typeof clientId !== 'string' || !isValidClientId(clientId)) {
    throw AppError.badRequest('Invalid client id.');
  }
  const ref = documentKey(collection, clientId);
  const snap = await tx.read(ref);
  if (!snap.exists) return { ref, clientSupplied: true, existing: null };
  if (snap.data?.userId !== uid) throw AppError.conflict('ID_CONFLICT', 'This id cannot be used.');
  return { ref, clientSupplied: true, existing: { id: ref.id, ...snap.data } };
}

/** Write a brand-new document at a resolved target (client ids must not overwrite). */
export function writeCreated(tx: SqlTransaction, target: CreateTarget, data: DocumentData): void {
  if (target.clientSupplied) tx.insert(target.ref, data);
  else tx.save(target.ref, data);
}

/** Split the optional client `id` off a create payload; the id is never stored in the body. */
export function takeClientId<T extends Record<string, any>>(
  input: T,
): { clientId: unknown; fields: Omit<T, 'id'> } {
  const { id: clientId, ...fields } = input;
  return { clientId, fields };
}
