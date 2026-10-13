import {
  addDocument,
  countQuery,
  documentKey,
  filterQuery,
  queryTable,
  readDocument,
  runSqlTransaction,
} from '../db/documents';
import { AppError } from '../utils/AppError';
export interface SortOption {
  field: string;
  dir: 'asc' | 'desc';
}
type Row = Record<string, any>;
/**
 * Generic CRUD for a collection whose documents carry a `userId` field.
 * Collapses the ~13 near-identical frontend hooks. Ownership is enforced on every
 * single-doc read/write. Sorting is done in memory to avoid composite indexes.
 */
export function userScopedRepo(collectionName: string) {
  const col = () => queryTable(collectionName);
  async function list(uid: string, sort?: SortOption): Promise<Row[]> {
    const snap = await readDocument(filterQuery(col(), 'userId', '==', uid));
    const rows: Row[] = snap.rows.map((d) => ({ id: d.id, ...d.data }));
    if (!sort) return rows;
    const { field, dir } = sort;
    return rows.sort((a, b) => {
      const av = a[field] ?? 0;
      const bv = b[field] ?? 0;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return dir === 'desc' ? -cmp : cmp;
    });
  }
  async function requireOwned(uid: string, id: string) {
    const ref = documentKey(col(), id);
    const snap = await readDocument(ref);
    if (!snap.exists) throw AppError.notFound();
    const data = snap.data as Row;
    if (data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
    return { ref, data };
  }
  async function get(uid: string, id: string): Promise<Row> {
    const { data } = await requireOwned(uid, id);
    return { id, ...data };
  }
  async function create(uid: string, data: Row, defaults: Row = {}): Promise<Row> {
    const ref = await addDocument(col(), {
      ...defaults,
      ...data,
      userId: uid,
      createdAt: Date.now(),
    });
    const snap = await readDocument(ref);
    return { id: ref.id, ...snap.data };
  }
  async function update(uid: string, id: string, patch: Row): Promise<Row> {
    const key = documentKey(col(), id);
    await runSqlTransaction(async (tx) => {
      const document = await tx.read(key);
      if (!document.exists) throw AppError.notFound();
      if (document.data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
      tx.save(key, patch, { merge: true });
    });
    return get(uid, id);
  }
  async function remove(uid: string, id: string): Promise<void> {
    const key = documentKey(col(), id);
    await runSqlTransaction(async (tx) => {
      const document = await tx.read(key);
      if (!document.exists) throw AppError.notFound();
      if (document.data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
      tx.remove(key);
    });
  }
  async function count(uid: string): Promise<number> {
    const snap = await readDocument(countQuery(filterQuery(col(), 'userId', '==', uid)));
    return snap.data.count;
  }
  return { collectionName, list, get, create, update, remove, count };
}
export type UserScopedRepo = ReturnType<typeof userScopedRepo>;
