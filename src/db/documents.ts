import { randomInt } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { database } from './database';
import { tables, entity, type Entity } from './tables';
import { IdempotencyConflict, idempotencyStorage, type IdempotencyContext } from './idempotencyContext';
import {
  collectionOf,
  isSyncEnabled,
  recordSyncChanges,
  syncScopeOf,
  type SyncChange,
} from './syncIndex';
import {
  decodeData,
  encodeData,
  mergeData,
  updateData,
  Timestamp,
  type DocumentData,
} from './values';

export { Timestamp, patchValue } from './values';
export type { DocumentData } from './values';
export interface DocumentKey {
  table: Entity;
  id: string;
}
export interface StoredDocument {
  id: string;
  key: DocumentKey;
  exists: boolean;
  data: DocumentData;
}
export interface Selection {
  rows: StoredDocument[];
  empty: boolean;
  size: number;
}
type Filter = {
  field: string;
  op: '==' | '>' | '>=' | '<' | '<=' | 'in' | 'array-contains';
  value: unknown;
};
export interface QuerySpec {
  table: Entity;
  filters: Filter[];
  order: Array<{ field: string; dir: 'asc' | 'desc' }>;
  take?: number;
  after?: StoredDocument;
}
export interface CountSpec {
  count: QuerySpec;
}
type Executor = Kysely<any> | Transaction<any>;
export const queryTable = (name: string): QuerySpec => ({
  table: entity(name),
  filters: [],
  order: [],
});
export const filterQuery = (
  query: QuerySpec,
  field: string,
  op: Filter['op'],
  value: unknown,
): QuerySpec => ({ ...query, filters: [...query.filters, { field, op, value }] });
export const orderQuery = (
  query: QuerySpec,
  field: string,
  dir: 'asc' | 'desc' = 'asc',
): QuerySpec => ({ ...query, order: [...query.order, { field, dir }] });
export const limitQuery = (query: QuerySpec, take: number): QuerySpec => {
  if (!Number.isSafeInteger(take) || take < 1) throw new Error('Invalid query limit');
  return { ...query, take };
};
export const afterQuery = (query: QuerySpec, after: StoredDocument): QuerySpec => ({
  ...query,
  after,
});
export const countQuery = (query: QuerySpec): CountSpec => ({ count: query });
export function newId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('');
}
export function documentKey(query: QuerySpec | Entity, id = newId()): DocumentKey {
  if (!id || Buffer.byteLength(id) > 2048 || id.includes('/'))
    throw new Error('Invalid document ID');
  return { table: typeof query === 'string' ? entity(query) : query.table, id };
}
export function field(data: DocumentData, path: string): any {
  return path
    .split('.')
    .reduce((value, part) => (value && Object.hasOwn(value, part) ? value[part] : undefined), data);
}
export const projections: Record<string, string> = {
  userId: 'user_id',
  householdId: 'household_id',
  cardId: 'card_id',
  categoryId: 'category_id',
  linkedTransactionId: 'linked_transaction_id',
  chatId: 'chat_id',
  username: 'username',
  status: 'status',
  createdAt: 'created_at_ms',
  updatedAt: 'updated_at_ms',
  date: 'date_ms',
  runAt: 'run_at_ms',
  nextAttemptAt: 'next_attempt_at_ms',
  leaseUntil: 'lease_until_ms',
  scheduledAt: 'scheduled_at_ms',
  'notifications.nextDailyAt': 'next_daily_at_ms',
  'familyAccess.householdId': 'family_household_id',
};
const stringFields = new Set([
  'userId',
  'householdId',
  'cardId',
  'categoryId',
  'linkedTransactionId',
  'chatId',
  'username',
  'status',
  'familyAccess.householdId',
]);
export function projected(data: DocumentData): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = {};
  for (const [path, column] of Object.entries(projections)) {
    const value = field(data, path);
    if (value === undefined || value === null) {
      result[column] = null;
      continue;
    }
    if (stringFields.has(path)) {
      // Legacy typed values are preserved in JSON and queried through JSON, not coerced.
      result[column] = typeof value === 'string' ? value : null;
      if (typeof value === 'string' && Buffer.byteLength(value) > (path === 'status' ? 64 : 2048))
        throw new Error('Projection exceeds schema capacity');
    } else {
      result[column] = typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
    }
  }
  const expiry =
    data.expiresAtMs ?? (data.expiresAt instanceof Timestamp ? data.expiresAt.toMillis() : null);
  result.expires_at_ms = typeof expiry === 'number' && Number.isSafeInteger(expiry) ? expiry : null;
  return result;
}
function jsonPath(path: string): string {
  return (
    '$' +
    path
      .split('.')
      .map((part) => `.${JSON.stringify(part)}`)
      .join('')
  );
}
function expression(path: string) {
  if (path === '__id__') return sql.ref('id');
  return sql<boolean>`JSON_EXTRACT(data_json, ${jsonPath(path)})`;
}
function predicate(filter: Filter) {
  const expr = expression(filter.field);
  const encoded = JSON.stringify(filter.value);
  if (encoded === undefined) throw new Error('Undefined query value');
  // Preserve missing/null and JSON type semantics. Index projections are additional
  // coarse conditions, never the authoritative test for a legacy document.
  const value = sql`CAST(${encoded} AS JSON)`;
  const matchingType =
    typeof filter.value === 'number'
      ? sql<boolean>`JSON_TYPE(${expr}) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE')`
      : typeof filter.value === 'string'
        ? sql<boolean>`JSON_TYPE(${expr}) = 'STRING'`
        : typeof filter.value === 'boolean'
          ? sql<boolean>`JSON_TYPE(${expr}) = 'BOOLEAN'`
          : filter.value === null
            ? sql<boolean>`JSON_TYPE(${expr}) = 'NULL'`
            : sql<boolean>`TRUE`;
  switch (filter.op) {
    case 'array-contains': {
      if (filter.value !== null && typeof filter.value === 'object')
        throw new Error('Object array-membership queries require an explicit mapping');
      return sql<boolean>`JSON_TYPE(${expr}) = 'ARRAY' AND JSON_CONTAINS(${expr}, ${value})`;
    }
    case 'in': {
      if (!Array.isArray(filter.value) || !filter.value.length)
        throw new Error('Invalid in filter');
      return sql<boolean>`(${sql.join(
        filter.value.map((item) => sql`${expr} = CAST(${JSON.stringify(item)} AS JSON)`),
        sql` OR `,
      )})`;
    }
    case '==':
      return sql<boolean>`${matchingType} AND ${expr} = ${value}`;
    case '>':
      return sql<boolean>`${matchingType} AND ${expr} > ${value}`;
    case '>=':
      return sql<boolean>`${matchingType} AND ${expr} >= ${value}`;
    case '<':
      return sql<boolean>`${matchingType} AND ${expr} < ${value}`;
    case '<=':
      return sql<boolean>`${matchingType} AND ${expr} <= ${value}`;
    default:
      throw new Error('Unsupported query operator');
  }
}
function selectQuery(spec: QuerySpec, executor: Executor) {
  let query = executor.selectFrom(tables[spec.table]).selectAll();
  for (const filter of spec.filters) {
    query = query.where(predicate(filter));
    if (
      spec.table === 'households' &&
      filter.field === 'memberIds' &&
      filter.op === 'array-contains' &&
      typeof filter.value === 'string'
    ) {
      query = query.where(
        sql<boolean>`EXISTS (SELECT 1 FROM household_members AS hm WHERE hm.household_id = households.id AND hm.user_id = ${Buffer.from(filter.value)})`,
      );
    }
    const column = projections[filter.field];
    if (
      column &&
      filter.value !== null &&
      filter.value !== undefined &&
      ((typeof filter.value === 'string' && stringFields.has(filter.field)) ||
        (typeof filter.value === 'number' &&
          Number.isSafeInteger(filter.value) &&
          !stringFields.has(filter.field)))
    ) {
      if (['==', '>', '>=', '<', '<='].includes(filter.op)) {
        const op = filter.op === '==' ? '=' : (filter.op as '>' | '>=' | '<' | '<=');
        query = query.where((eb) => eb.or([eb(column, op, filter.value), eb(column, 'is', null)]));
      }
    }
  }
  const implicitFields = [
    ...new Set(
      spec.filters
        .filter((filter) => ['<', '<=', '>', '>='].includes(filter.op))
        .map((filter) => filter.field),
    ),
  ].sort();
  const order = spec.order.length
    ? [...spec.order]
    : implicitFields.length
      ? implicitFields.map((field) => ({ field, dir: 'asc' as const }))
      : [{ field: '__id__', dir: 'asc' as const }];
  if (!order.some((item) => item.field === '__id__'))
    order.push({ field: '__id__', dir: order.at(-1)!.dir });
  for (const item of order) {
    // Firestore orderBy excludes documents missing the ordered field.
    if (item.field !== '__id__')
      query = query.where(
        sql<boolean>`JSON_CONTAINS_PATH(data_json, 'one', ${jsonPath(item.field)}) = 1`,
      );
    query = query.orderBy(expression(item.field), item.dir);
  }
  if (spec.after) {
    const cursor = spec.after;
    const terms = order.map((item, i) => {
      const value =
        item.field === '__id__'
          ? Buffer.from(cursor.id)
          : sql`CAST(${JSON.stringify(field(cursor.data, item.field))} AS JSON)`;
      const comparison =
        item.dir === 'asc'
          ? sql`${expression(item.field)} > ${value}`
          : sql`${expression(item.field)} < ${value}`;
      const equals = order.slice(0, i).map((prior) => {
        const priorValue =
          prior.field === '__id__'
            ? Buffer.from(cursor.id)
            : sql`CAST(${JSON.stringify(field(cursor.data, prior.field))} AS JSON)`;
        return sql<boolean>`${expression(prior.field)} = ${priorValue}`;
      });
      return sql<boolean>`(${sql.join([...equals, comparison], sql` AND `)})`;
    });
    query = query.where(sql<boolean>`(${sql.join(terms, sql` OR `)})`);
  }
  if (spec.take) query = query.limit(spec.take);
  return query;
}
function stored(key: DocumentKey, row?: any): StoredDocument {
  return {
    id: key.id,
    key,
    exists: Boolean(row),
    data: row ? decodeData(row.data_json, row.types_json) : (undefined as unknown as DocumentData),
  };
}
function rowId(row: any): string {
  return Buffer.isBuffer(row.id) ? row.id.toString('utf8') : row.id;
}
export async function readDocument(key: DocumentKey): Promise<StoredDocument>;
export async function readDocument(query: QuerySpec): Promise<Selection>;
export async function readDocument(query: CountSpec): Promise<{ data: { count: number } }>;
export async function readDocument(input: DocumentKey | QuerySpec | CountSpec): Promise<any> {
  try {
    return await readUsing(input, database(), false);
  } catch (error) {
    throw storageError(error);
  }
}
function storageError(error: unknown): unknown {
  if (error && typeof error === 'object' && ('sql' in error || 'sqlMessage' in error)) {
    return Object.assign(new Error('SQL operation failed'), {
      code: (error as { code?: string }).code,
    });
  }
  if (error instanceof SyntaxError)
    return Object.assign(new Error('Invalid stored document'), {
      code: 'INVALID_STORAGE_DOCUMENT',
    });
  return error;
}
async function readUsing(
  input: DocumentKey | QuerySpec | CountSpec,
  executor: Executor,
  locking: boolean,
): Promise<any> {
  if ('count' in input) {
    const result = await selectQuery(input.count, executor)
      .clearSelect()
      .clearOrderBy()
      .select(sql`COUNT(*)`.as('total'))
      .executeTakeFirstOrThrow();
    return { data: { count: Number(result.total) } };
  }
  if ('id' in input) {
    let query = executor
      .selectFrom(tables[input.table])
      .selectAll()
      .where('id', '=', Buffer.from(input.id));
    if (locking) query = query.forUpdate();
    return stored(input, await query.executeTakeFirst());
  }
  let query = selectQuery(input, executor);
  if (locking) query = query.forUpdate();
  const rows = (await query.execute()).map((row) => stored(documentKey(input, rowId(row)), row));
  return { rows, empty: rows.length === 0, size: rows.length };
}

type Write = {
  kind: 'save' | 'insert' | 'patch' | 'remove';
  key: DocumentKey;
  data?: DocumentData;
  merge?: boolean;
};
export async function syncHouseholdMembers(
  executor: Executor,
  key: DocumentKey,
  data?: DocumentData,
): Promise<void> {
  if (key.table !== 'households') return;
  await executor
    .deleteFrom('household_members')
    .where('household_id', '=', Buffer.from(key.id))
    .execute();
  const memberIds: unknown[] = Array.isArray(data?.memberIds) ? data.memberIds : [];
  const rows = memberIds.flatMap((uid, index) =>
    typeof uid === 'string'
      ? [{ household_id: Buffer.from(key.id), member_index: index, user_id: Buffer.from(uid) }]
      : [],
  );
  if (rows.length) await executor.insertInto('household_members').values(rows).execute();
}
export class SqlTransaction {
  private readonly writes: Write[] = [];
  constructor(private readonly executor?: Executor) {}
  read(key: DocumentKey): Promise<StoredDocument>;
  read(query: QuerySpec): Promise<Selection>;
  read(input: DocumentKey | QuerySpec): Promise<any> {
    if (!this.executor) throw new Error('Batch cannot read');
    if (this.writes.length) throw new Error('Read all records before scheduling writes');
    return readUsing(input, this.executor, true);
  }
  save(key: DocumentKey, data: DocumentData, options?: { merge?: boolean }): void {
    this.writes.push({ kind: 'save', key, data, merge: options?.merge });
  }
  insert(key: DocumentKey, data: DocumentData): void {
    this.writes.push({ kind: 'insert', key, data });
  }
  patch(key: DocumentKey, data: DocumentData): void {
    this.writes.push({ kind: 'patch', key, data });
  }
  remove(key: DocumentKey): void {
    this.writes.push({ kind: 'remove', key });
  }
  /** True when the transaction writes anything besides idempotency markers. */
  hasEffectWrites(): boolean {
    return this.writes.some((write) => write.key.table !== 'idempotencyKeys');
  }
  async flush(executor: Executor): Promise<void> {
    const changes = new Map<string, SyncChange>();
    const track = (
      key: DocumentKey,
      data: DocumentData | undefined,
      deleted: boolean,
      previous?: DocumentData,
    ) => {
      if (!isSyncEnabled()) return;
      const scope = syncScopeOf(key.table, key.id, data);
      const before = previous ? syncScopeOf(key.table, key.id, previous) : null;
      // A document that moved to another owner is a delete for the old owner's feed.
      if (before && before !== scope)
        changes.set(`${before}\0${key.table}\0${key.id}`, {
          scope: before,
          entity: key.table,
          id: key.id,
          deleted: true,
        });
      if (scope)
        changes.set(`${scope}\0${key.table}\0${key.id}`, {
          scope,
          entity: key.table,
          id: key.id,
          deleted,
        });
    };
    for (const write of this.writes) {
      const table = tables[write.key.table];
      const id = Buffer.from(write.key.id);
      if (write.kind === 'remove') {
        // The owner is only known from the stored document (needed for the tombstone scope).
        const old =
          isSyncEnabled() && collectionOf(write.key.table)
            ? ((await readUsing(write.key, executor, true)) as StoredDocument)
            : undefined;
        await syncHouseholdMembers(executor, write.key);
        await executor.deleteFrom(table).where('id', '=', id).execute();
        if (old?.exists) track(write.key, old.data, true);
        continue;
      }
      const old = (await readUsing(write.key, executor, true)) as StoredDocument;
      if (write.kind === 'insert' && old.exists)
        throw Object.assign(new Error('Record already exists'), {
          code: 'already-exists',
          key: write.key,
        });
      if (write.kind === 'patch' && !old.exists)
        throw Object.assign(new Error('Record not found'), { code: 'not-found' });
      const data =
        write.kind === 'patch'
          ? updateData(old.data, write.data!)
          : mergeData(write.merge ? (old.data ?? {}) : {}, write.data!);
      const values = { id, ...encodeData(data), ...projected(data) };
      if (old.exists) await executor.updateTable(table).set(values).where('id', '=', id).execute();
      else await executor.insertInto(table).values(values).execute();
      await syncHouseholdMembers(executor, write.key, data);
      track(write.key, data, false, old.exists ? old.data : undefined);
    }
    // Last: the per-user counter lock must be taken after every document lock.
    await recordSyncChanges(executor, [...changes.values()]);
  }
  async commit(): Promise<void> {
    if (this.executor) throw new Error('Transactions commit only through the transaction runner');
    await runSqlTransaction(async (context) => {
      context.writes.push(...this.writes);
    });
  }
}
export function writeBatch(): SqlTransaction {
  return new SqlTransaction();
}
/**
 * Insert the request's idempotency marker. A duplicate primary key means another request
 * (or an earlier attempt) already holds this key: reported as IdempotencyConflict.
 */
export async function insertIdempotencyMarker(
  executor: Executor,
  context: IdempotencyContext,
  extra: { effect?: unknown; status?: number; body?: unknown },
): Promise<void> {
  const now = Date.now();
  const data: DocumentData = {
    userId: context.uid,
    key: context.key,
    method: context.method,
    path: context.path,
    requestHash: context.requestHash,
    successStatus: context.successStatus,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now + 30 * 86_400_000),
  };
  const effect = jsonSnapshot(extra.effect);
  if (effect !== undefined) data.effect = effect;
  if (extra.status !== undefined) {
    data.status = extra.status;
    data.completedAt = now;
    const body = jsonSnapshot(extra.body);
    if (body !== undefined) data.body = body;
  }
  const values = { id: Buffer.from(context.markerId), ...encodeData(data), ...projected(data) };
  try {
    await executor.insertInto(tables.idempotencyKeys).values(values).execute();
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new IdempotencyConflict();
    throw error;
  }
}
/** Plain-JSON copy of an effect result for the idempotency marker; undefined when unusable. */
function jsonSnapshot(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > 200_000) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
export async function runSqlTransaction<T>(
  work: (context: SqlTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Re-read per attempt: a retried attempt of a claimed request must not claim twice.
    const idempotency = idempotencyStorage.getStore();
    let carriesMarker = false;
    try {
      const result = await database()
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`SET time_zone = '+00:00'`.execute(trx);
          const context = new SqlTransaction(trx);
          const result = await work(context);
          carriesMarker = Boolean(
            idempotency && !idempotency.claimed && isSyncEnabled() && context.hasEffectWrites(),
          );
          // Plain INSERT first: no pre-read, so no gap locks shared with other users' markers.
          if (carriesMarker) await insertIdempotencyMarker(trx, idempotency!, { effect: result });
          await context.flush(trx);
          return result;
        });
      if (carriesMarker) idempotency!.claimed = true;
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (error instanceof IdempotencyConflict) throw error;
      if (attempt >= 4 || !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code ?? ''))
        throw storageError(error);
      await new Promise((resolve) => setTimeout(resolve, randomInt(10, 50) * (attempt + 1)));
    }
  }
}
export async function saveDocument(
  key: DocumentKey,
  data: DocumentData,
  options?: { merge?: boolean },
): Promise<void> {
  await runSqlTransaction(async (tx) => {
    tx.save(key, data, options);
  });
}
export async function insertDocument(key: DocumentKey, data: DocumentData): Promise<void> {
  await runSqlTransaction(async (tx) => {
    tx.insert(key, data);
  });
}
export async function patchDocument(key: DocumentKey, data: DocumentData): Promise<void> {
  await runSqlTransaction(async (tx) => {
    tx.patch(key, data);
  });
}
export async function removeDocument(key: DocumentKey): Promise<void> {
  await runSqlTransaction(async (tx) => {
    tx.remove(key);
  });
}
export async function addDocument(query: QuerySpec, data: DocumentData): Promise<DocumentKey> {
  const key = documentKey(query);
  await insertDocument(key, data);
  return key;
}
