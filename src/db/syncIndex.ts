import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DocumentData } from './values';
import type { Entity } from './tables';

type Executor = Kysely<any> | Transaction<any>;

/** API collection name -> storage entity. Only these are exposed through `/v1/sync/changes`. */
export const SYNC_COLLECTIONS = {
  profile: 'profiles',
  settings: 'userSettings',
  categories: 'categories',
  subcategories: 'subcategories',
  cards: 'cards',
  transactions: 'transactions',
  budgets: 'budgets',
  savingsGoals: 'savingsGoals',
  debts: 'debts',
  deposits: 'deposits',
  subscriptions: 'subscriptions',
  plannedExpenses: 'planned_expenses',
} as const satisfies Record<string, Entity>;
export type SyncCollection = keyof typeof SYNC_COLLECTIONS;
const entityToCollection = new Map<string, SyncCollection>(
  Object.entries(SYNC_COLLECTIONS).map(([collection, entity]) => [entity, collection as SyncCollection]),
);
/** Entities whose document id is the owner's uid (no `userId` field required). */
const keyedByUid = new Set<string>(['profiles', 'userSettings']);

export const collectionOf = (entity: string): SyncCollection | undefined =>
  entityToCollection.get(entity);

/**
 * Which user feed a document belongs to, or null when it is not part of any feed.
 * The personal feed is exactly the set of documents the personal GET endpoints return:
 * `userId == uid`. Household-owned rows (`userId: 'household:<id>'`) are not synced in v1.
 */
export function syncScopeOf(entity: string, id: string, data: DocumentData | undefined): string | null {
  if (!entityToCollection.has(entity)) return null;
  if (keyedByUid.has(entity)) return `u:${id}`;
  const owner = data?.userId;
  if (typeof owner !== 'string' || !owner || owner.startsWith('household:')) return null;
  return `u:${owner}`;
}

let enabled = false;
export const isSyncEnabled = (): boolean => enabled;
export function setSyncEnabled(value: boolean): void {
  enabled = value;
}
/** Kill switch for operators; the migration marker decides otherwise. */
export const syncKillSwitch = (): boolean => process.env.OFFLINE_SYNC_ENABLED === 'false';
/** Bump when sync was off for a while so clients holding older cursors resnapshot. */
export const syncEpoch = (): number => {
  const value = Number(process.env.SYNC_EPOCH ?? 1);
  return Number.isInteger(value) && value >= 1 ? value : 1;
};
export const SYNC_MIGRATION = '003_offline_sync';
/**
 * Sync is on only when migration 003 is applied (runtime DB user has DML only, so the
 * owner applies it). Without it every write path keeps working exactly as before.
 */
export async function initOfflineSync(db: Executor): Promise<boolean> {
  if (syncKillSwitch()) {
    enabled = false;
    return false;
  }
  try {
    const result = await sql<{
      version: string;
    }>`SELECT version FROM schema_migrations WHERE version = ${SYNC_MIGRATION}`.execute(db);
    enabled = result.rows.length === 1;
  } catch (error) {
    // Only "tables are not there yet" means off; a transient DB error must fail the boot
    // loudly instead of silently dropping changes for the life of the process.
    if ((error as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw error;
    enabled = false;
  }
  return enabled;
}

export const keyHash = (entity: string, id: string): Buffer =>
  createHash('sha256').update(`${entity}\0${id}`).digest();

export interface SyncChange {
  scope: string;
  entity: string;
  id: string;
  deleted: boolean;
}

/**
 * Assign sequence numbers and upsert one index entry per changed document.
 *
 * Runs inside the writer's transaction, AFTER every document write. It takes the
 * per-scope counter row lock last and holds it until commit, so sequence numbers
 * follow commit order and a reader that sees N sees every lower number. Scopes are
 * locked in sorted order so two writers can never deadlock on counters.
 */
export async function recordSyncChanges(executor: Executor, changes: SyncChange[]): Promise<void> {
  if (!enabled || !changes.length) return;
  const byScope = new Map<string, SyncChange[]>();
  for (const change of changes) {
    const list = byScope.get(change.scope) ?? [];
    list.push(change);
    byScope.set(change.scope, list);
  }
  const now = Date.now();
  for (const scope of [...byScope.keys()].sort()) {
    const list = byScope.get(scope)!;
    const scopeKey = Buffer.from(scope);
    await sql`INSERT INTO sync_state (scope, seq, floor_seq, updated_at_ms) VALUES (${scopeKey}, ${list.length}, 0, ${now}) ON DUPLICATE KEY UPDATE seq = seq + ${list.length}, updated_at_ms = ${now}`.execute(
      executor,
    );
    const head = await sql<{
      seq: string | number;
    }>`SELECT seq FROM sync_state WHERE scope = ${scopeKey}`.execute(executor);
    let seq = Number(head.rows[0].seq) - list.length;
    for (const change of list) {
      seq += 1;
      await sql`INSERT INTO sync_entries (scope, key_hash, entity, doc_id, seq, deleted, updated_at_ms) VALUES (${scopeKey}, ${keyHash(change.entity, change.id)}, ${change.entity}, ${Buffer.from(change.id)}, ${seq}, ${change.deleted ? 1 : 0}, ${now}) ON DUPLICATE KEY UPDATE seq = ${seq}, deleted = ${change.deleted ? 1 : 0}, updated_at_ms = ${now}`.execute(
        executor,
      );
    }
  }
}

/**
 * Drop old tombstones and remember the highest dropped sequence in `floor_seq`.
 * Cursors below the floor are answered with 410 so the client resnapshots.
 */
export async function pruneSyncTombstones(
  db: Kysely<any>,
  retentionMs: number,
  now = Date.now(),
): Promise<number> {
  const cutoff = now - retentionMs;
  let removed = 0;
  for (let round = 0; round < 10; round++) {
    const scopes = await sql<{
      scope: Buffer;
    }>`SELECT DISTINCT scope FROM sync_entries WHERE deleted = 1 AND updated_at_ms < ${cutoff} LIMIT 200`.execute(
      db,
    );
    if (!scopes.rows.length) break;
    for (const row of scopes.rows) {
      removed += await pruneScope(db, row.scope, cutoff);
    }
  }
  return removed;
}
async function pruneScope(db: Kysely<any>, scope: Buffer, cutoff: number): Promise<number> {
  let removed = 0;
  await db.transaction().execute(async (trx) => {
    await sql`SELECT seq FROM sync_state WHERE scope = ${scope} FOR UPDATE`.execute(trx);
    const max = await sql<{
      seq: string | number | null;
    }>`SELECT MAX(seq) AS seq FROM sync_entries WHERE scope = ${scope} AND deleted = 1 AND updated_at_ms < ${cutoff}`.execute(
      trx,
    );
    const floor = max.rows[0]?.seq;
    if (floor === null || floor === undefined) return;
    const result = await sql`DELETE FROM sync_entries WHERE scope = ${scope} AND deleted = 1 AND updated_at_ms < ${cutoff}`.execute(
      trx,
    );
    removed = Number(result.numAffectedRows ?? 0);
    await sql`UPDATE sync_state SET floor_seq = GREATEST(floor_seq, ${Number(floor)}) WHERE scope = ${scope}`.execute(
      trx,
    );
  });
  return removed;
}
