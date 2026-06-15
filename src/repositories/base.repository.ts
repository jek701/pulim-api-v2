import { db } from '../config/firebase';
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
  const col = () => db.collection(collectionName);

  async function list(uid: string, sort?: SortOption): Promise<Row[]> {
    const snap = await col().where('userId', '==', uid).get();
    const rows: Row[] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
    const ref = col().doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw AppError.notFound();
    const data = snap.data() as Row;
    if (data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your resource.');
    return { ref, data };
  }

  async function get(uid: string, id: string): Promise<Row> {
    const { data } = await requireOwned(uid, id);
    return { id, ...data };
  }

  async function create(uid: string, data: Row, defaults: Row = {}): Promise<Row> {
    const ref = await col().add({ ...defaults, ...data, userId: uid, createdAt: Date.now() });
    const snap = await ref.get();
    return { id: ref.id, ...snap.data() };
  }

  async function update(uid: string, id: string, patch: Row): Promise<Row> {
    const { ref } = await requireOwned(uid, id);
    await ref.set(patch, { merge: true });
    const snap = await ref.get();
    return { id, ...snap.data() };
  }

  async function remove(uid: string, id: string): Promise<void> {
    const { ref } = await requireOwned(uid, id);
    await ref.delete();
  }

  async function count(uid: string): Promise<number> {
    const snap = await col().where('userId', '==', uid).count().get();
    return snap.data().count;
  }

  return { collectionName, col, list, requireOwned, get, create, update, remove, count };
}

export type UserScopedRepo = ReturnType<typeof userScopedRepo>;
