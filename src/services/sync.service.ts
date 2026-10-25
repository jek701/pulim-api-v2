import { sql } from 'kysely';
import { database } from '../db/database';
import {
  documentKey,
  filterQuery,
  limitQuery,
  afterQuery,
  queryTable,
  readDocument,
  type StoredDocument,
} from '../db/documents';
import { tables, type Entity } from '../db/tables';
import { decodeData } from '../db/values';
import {
  SYNC_COLLECTIONS,
  collectionOf,
  isSyncEnabled,
  syncEpoch,
  type SyncCollection,
} from '../db/syncIndex';
import { CLIENT_ID_PATTERN } from '../domain/clientId';
import { AppError } from '../utils/AppError';

export const SYNC_CONTRACT_VERSION = 1;
export const SYNC_DEFAULT_LIMIT = 200;
export const SYNC_MAX_LIMIT = 500;
/** Snapshot order: referenced documents before their referrers. */
const SNAPSHOT_ORDER: SyncCollection[] = [
  'profile',
  'settings',
  'categories',
  'subcategories',
  'cards',
  'savingsGoals',
  'debts',
  'deposits',
  'subscriptions',
  'plannedExpenses',
  'budgets',
  'transactions',
];
const KEYED_BY_UID = new Set<SyncCollection>(['profile', 'settings']);

type Doc = Record<string, unknown>;
export type SyncPage = {
  mode: 'snapshot' | 'delta';
  cursor: string;
  hasMore: boolean;
  serverTime: number;
  collections: Partial<Record<SyncCollection, { upserted: Doc[]; deleted: string[] }>>;
};

type Cursor =
  | { kind: 'delta'; seq: number }
  | { kind: 'snapshot'; head: number; index: number; after: string | null };

const encodeCursor = (cursor: Cursor): string =>
  cursor.kind === 'delta'
    ? `d1.${syncEpoch()}.${cursor.seq}`
    : `s1.${Buffer.from(JSON.stringify([syncEpoch(), cursor.head, cursor.index, cursor.after])).toString('base64url')}`;

function decodeCursor(text: string): Cursor {
  const invalid = () => new AppError(400, 'INVALID_CURSOR', 'The sync cursor is malformed.');
  const expired = () =>
    new AppError(410, 'CURSOR_EXPIRED', 'The sync cursor is no longer valid; start a new snapshot.');
  try {
    if (text.startsWith('d1.')) {
      const [, epoch, seq] = text.split('.');
      if (!/^\d+$/.test(epoch ?? '') || !/^\d+$/.test(seq ?? '')) throw invalid();
      if (Number(epoch) !== syncEpoch()) throw expired();
      return { kind: 'delta', seq: Number(seq) };
    }
    if (text.startsWith('s1.')) {
      const parsed = JSON.parse(Buffer.from(text.slice(3), 'base64url').toString('utf8'));
      const [epoch, head, index, after] = parsed as [unknown, unknown, unknown, unknown];
      if (
        !Number.isSafeInteger(epoch) ||
        !Number.isSafeInteger(head) ||
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= SNAPSHOT_ORDER.length ||
        !(after === null || (typeof after === 'string' && after.length <= 2048))
      )
        throw invalid();
      if (epoch !== syncEpoch()) throw expired();
      return { kind: 'snapshot', head: head as number, index: index as number, after: after as string | null };
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
  throw invalid();
}

async function readState(
  db: ReturnType<typeof database>,
  uid: string,
): Promise<{ head: number; floor: number }> {
  const result = await sql<{
    seq: string | number;
    floor_seq: string | number;
  }>`SELECT seq, floor_seq FROM sync_state WHERE scope = ${Buffer.from(`u:${uid}`)}`.execute(db);
  const row = result.rows[0];
  return { head: row ? Number(row.seq) : 0, floor: row ? Number(row.floor_seq) : 0 };
}

const add = (page: SyncPage['collections'], collection: SyncCollection) =>
  (page[collection] ??= { upserted: [], deleted: [] });

export function syncCapabilities() {
  const collections = Object.keys(SYNC_COLLECTIONS);
  return {
    contract: SYNC_CONTRACT_VERSION,
    offlineSync: isSyncEnabled(),
    idempotency: {
      header: 'Idempotency-Key',
      keyPattern: '^[A-Za-z0-9_-]{16,128}$',
      ttlDays: 30,
    },
    clientIds: {
      pattern: CLIENT_ID_PATTERN.source,
      collections: [
        'transactions',
        'cards',
        'categories',
        'subcategories',
        'savingsGoals',
        'debts',
        'deposits',
        'subscriptions',
        'plannedExpenses',
      ],
    },
    changes: { defaultLimit: SYNC_DEFAULT_LIMIT, maxLimit: SYNC_MAX_LIMIT, collections },
    serverTime: Date.now(),
  };
}

export async function pullChanges(
  uid: string,
  cursorText: string | undefined,
  limit: number,
): Promise<SyncPage> {
  if (!isSyncEnabled()) {
    throw new AppError(503, 'SYNC_UNAVAILABLE', 'Offline sync is not enabled on this server.');
  }
  const cursor = cursorText ? decodeCursor(cursorText) : undefined;
  if (cursor?.kind === 'delta') return pullDelta(uid, cursor.seq, limit);
  return pullSnapshot(uid, cursor, limit);
}

async function pullSnapshot(
  uid: string,
  cursor: Extract<Cursor, { kind: 'snapshot' }> | undefined,
  limit: number,
): Promise<SyncPage> {
  // The head is read BEFORE any document: changes during paging are replayed by the
  // first delta call (upserts are idempotent).
  const state = cursor ? null : await readState(database(), uid);
  const head = cursor?.head ?? state!.head;
  let index = cursor?.index ?? 0;
  let after = cursor?.after ?? null;
  const collections: SyncPage['collections'] = {};
  let remaining = limit;
  while (remaining > 0 && index < SNAPSHOT_ORDER.length) {
    const collection = SNAPSHOT_ORDER[index];
    const entity = SYNC_COLLECTIONS[collection] as Entity;
    if (KEYED_BY_UID.has(collection)) {
      const doc = await readDocument(documentKey(entity, uid));
      if (doc.exists) {
        add(collections, collection).upserted.push({ id: doc.id, ...doc.data });
        remaining -= 1;
      }
      index += 1;
      after = null;
      continue;
    }
    let query = limitQuery(filterQuery(queryTable(entity), 'userId', '==', uid), remaining + 1);
    if (after !== null) {
      const cursorDoc: StoredDocument = {
        id: after,
        key: documentKey(entity, after),
        exists: true,
        data: {},
      };
      query = afterQuery(query, cursorDoc);
    }
    const snap = await readDocument(query);
    const rows = snap.rows.slice(0, remaining);
    for (const row of rows) add(collections, collection).upserted.push({ id: row.id, ...row.data });
    if (snap.rows.length > remaining) {
      after = rows[rows.length - 1].id;
      remaining = 0;
      break;
    }
    remaining -= rows.length;
    index += 1;
    after = null;
  }
  const hasMore = index < SNAPSHOT_ORDER.length;
  return {
    mode: 'snapshot',
    cursor: hasMore
      ? encodeCursor({ kind: 'snapshot', head, index, after })
      : encodeCursor({ kind: 'delta', seq: head }),
    hasMore,
    serverTime: Date.now(),
    collections,
  };
}

async function pullDelta(uid: string, since: number, limit: number): Promise<SyncPage> {
  const scope = Buffer.from(`u:${uid}`);
  // One snapshot for head, index entries and documents: everything is mutually consistent.
  return database()
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const { head, floor } = await readState(trx as never, uid);
      if (since < floor || since > head) {
        throw new AppError(
          410,
          'CURSOR_EXPIRED',
          'The sync cursor is no longer valid; start a new snapshot.',
        );
      }
      const result = await sql<{
        entity: string;
        doc_id: Buffer;
        seq: string | number;
        deleted: number;
      }>`SELECT entity, doc_id, seq, deleted FROM sync_entries WHERE scope = ${scope} AND seq > ${since} ORDER BY seq ASC LIMIT ${limit + 1}`.execute(
        trx,
      );
      const hasMore = result.rows.length > limit;
      const entries = result.rows.slice(0, limit);
      const collections: SyncPage['collections'] = {};
      const wanted = new Map<string, string[]>();
      for (const entry of entries) {
        const collection = collectionOf(entry.entity);
        if (!collection) continue;
        const id = entry.doc_id.toString('utf8');
        if (entry.deleted) {
          add(collections, collection).deleted.push(id);
          continue;
        }
        const ids = wanted.get(entry.entity) ?? [];
        ids.push(id);
        wanted.set(entry.entity, ids);
      }
      for (const [entityName, ids] of wanted) {
        const collection = collectionOf(entityName)!;
        const rows = await trx
          .selectFrom(tables[entityName as Entity])
          .selectAll()
          .where(
            'id',
            'in',
            ids.map((id) => Buffer.from(id)),
          )
          .execute();
        const found = new Map<string, Doc>();
        for (const row of rows) {
          const id = Buffer.isBuffer(row.id) ? row.id.toString('utf8') : String(row.id);
          const data = decodeData(row.data_json, row.types_json);
          // A document that no longer belongs to this user is a delete for this feed.
          if (!KEYED_BY_UID.has(collection) && data.userId !== uid) continue;
          found.set(id, { id, ...data });
        }
        for (const id of ids) {
          const doc = found.get(id);
          if (doc) add(collections, collection).upserted.push(doc);
          else add(collections, collection).deleted.push(id);
        }
      }
      const next = hasMore ? Number(entries[entries.length - 1].seq) : head;
      return {
        mode: 'delta' as const,
        cursor: encodeCursor({ kind: 'delta', seq: next }),
        hasMore,
        serverTime: Date.now(),
        collections,
      };
    });
}
