import { sql, type RawBuilder } from 'kysely';
import { database } from './database';
import { tables, type Entity } from './tables';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { documentKey, filterQuery, queryTable, readDocument, projected } from './documents';
import { decodeData, encodeData } from './values';
import { recordSyncChanges, syncScopeOf, type SyncChange } from './syncIndex';

/** Every non-document table created by the two migrations requires a retention decision. */
export const relationalDeletionPolicy = {
  schema_migrations: 'keep-schema',
  migration_runs: 'keep-manifest',
  migration_documents: 'archive',
  legacy_documents: 'archive',
  household_members: 'household',
  push_devices: 'uid',
  sync_entries: 'scope',
  sync_state: 'scope',
  capture_issued: 'uid',
  capture_usage: 'uid',
  capture_refunds: 'uid',
  merchant_user_category: 'uid',
  capture_owner_summary: 'owner-hash',
  capture_learning: 'transaction-hash-before-transactions',
  capture_receipt_cache: 'receipt-key-before-transactions',
  merchants: 'keep-directory',
  merchant_category_votes: 'keep-aggregate',
  merchant_latest_votes: 'keep-hmac',
  ikpu_category_map: 'keep-directory',
} as const;

export const DELETION_BATCH_SIZE = 1000;
export const jsonEquals = (field: string, value: string) =>
  sql<boolean>`JSON_EXTRACT(data_json, ${`$.${field}`}) = CAST(${JSON.stringify(value)} AS JSON)`;

/** Deliberately below SqlTransaction.flush: no notification hooks or sync tombstones. */
export async function deleteBatches(
  table: string,
  where: RawBuilder<boolean>,
  optional = false,
): Promise<number> {
  let total = 0;
  try {
    while (true) {
      const result =
        await sql`DELETE FROM ${sql.table(table)} WHERE ${where} LIMIT ${DELETION_BATCH_SIZE}`.execute(
          database(),
        );
      const count = Number(result.numAffectedRows ?? 0);
      total += count;
      if (count < DELETION_BATCH_SIZE) return total;
    }
  } catch (error) {
    if (optional && (error as { code?: string }).code === 'ER_NO_SUCH_TABLE') return total;
    // Do not leak SQL parameters through the central error logger.
    throw Object.assign(new Error('Account deletion storage operation failed'), {
      code: (error as { code?: string }).code,
    });
  }
}

/** Scan without locking ranges, then delete only selected primary keys. */
export async function deleteSelectedBatches(
  table: string,
  where: RawBuilder<boolean>,
  optional = false,
  keys = ['id'],
): Promise<number> {
  let total = 0;
  try {
    while (true) {
      const selected = await sql<Record<string, any>>`SELECT ${sql.join(keys.map(sql.ref))}
        FROM ${sql.table(table)} WHERE ${where} LIMIT ${DELETION_BATCH_SIZE}`.execute(database());
      if (!selected.rows.length) return total;
      const matches = selected.rows.map(
        (row) =>
          sql<boolean>`(${sql.join(
            keys.map((key) => sql`${sql.ref(key)} = ${row[key]}`),
            sql` AND `,
          )})`,
      );
      const selectedKeys =
        keys.length === 1
          ? sql`${sql.ref(keys[0])} IN (${sql.join(selected.rows.map((row) => row[keys[0]]))})`
          : sql`(${sql.join(matches, sql` OR `)})`;
      const result = await sql`DELETE FROM ${sql.table(table)} WHERE ${selectedKeys}`.execute(
        database(),
      );
      total += Number(result.numAffectedRows ?? 0);
    }
  } catch (error) {
    if (optional && (error as { code?: string }).code === 'ER_NO_SUCH_TABLE') return total;
    throw Object.assign(new Error('Account deletion storage operation failed'), {
      code: (error as { code?: string }).code,
    });
  }
}

export async function deleteByOwner(entity: Entity, uid: string): Promise<number> {
  return deleteBatches(tables[entity], sql<boolean>`user_id = ${Buffer.from(uid)}`);
}

/** Also handles rows whose owner is not projected to user_id. */
export async function deleteByField(entity: Entity, field: string, value: string): Promise<number> {
  if (field === '__id__')
    return deleteBatches(tables[entity], sql<boolean>`id = ${Buffer.from(value)}`);
  const columns: Record<string, string> = {
    userId: 'user_id',
    householdId: 'household_id',
    chatId: 'chat_id',
    'familyAccess.householdId': 'family_household_id',
  };
  const column = columns[field];
  let count = column
    ? await deleteBatches(
        tables[entity],
        sql<boolean>`${sql.ref(column)} = ${Buffer.from(value)} AND ${jsonEquals(field, value)}`,
      )
    : await deleteSelectedBatches(tables[entity], jsonEquals(field, value));
  // Numeric legacy chat ids have a NULL string projection. Do not coerce unrelated JSON types.
  if (field === 'chatId' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)))
    count += await deleteSelectedBatches(
      tables[entity],
      sql<boolean>`
      JSON_TYPE(JSON_EXTRACT(data_json, '$.chatId')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE')
      AND JSON_EXTRACT(data_json, '$.chatId') = CAST(${JSON.stringify(Number(value))} AS JSON)`,
    );
  return count;
}

export async function markDeletion(uid: string): Promise<void> {
  // UPDATE only: a retry after profile removal must never recreate it.
  await sql`UPDATE profiles SET data_json = JSON_SET(data_json,
    '$.deletionRequestedAt', COALESCE(JSON_EXTRACT(data_json, '$.deletionRequestedAt'), ${Date.now()}))
    WHERE id = ${Buffer.from(uid)}`.execute(database());
}

/** Must precede deleting mappings/transactions: these supply the indirect ownership keys. */
export async function purgeRelated(uid: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const profile = await readDocument(documentKey('profiles', uid));
  const ownedHouseholds = await readDocument(
    filterQuery(queryTable('households'), 'ownerUserId', '==', uid),
  );
  const ids = new Set<string>((profile.data?.telegramChatIds ?? []).map(String));
  for (const field of ['profileUid', 'uid']) {
    const mappings = await readDocument(filterQuery(queryTable('telegramUsers'), field, '==', uid));
    for (const row of mappings.rows) {
      ids.add(row.id);
      if (row.data.chatId) ids.add(String(row.data.chatId));
    }
  }
  if (uid.startsWith('tg_')) ids.add(uid.slice(3));
  for (const id of ids) {
    counts.telegram_sessions =
      (counts.telegram_sessions ?? 0) + (await deleteByField('telegramSessions', '__id__', id));
    for (const entity of ['telegramMessages', 'telegramDrafts', 'telegramLoginRequests'] as const)
      counts[tables[entity]] =
        (counts[tables[entity]] ?? 0) + (await deleteByField(entity, 'chatId', id));
    // Pending updates have userId:null and a serialized payload. Compare exact Telegram ids,
    // never substring-match text (which could delete another person's update).
    counts.telegram_updates =
      (counts.telegram_updates ?? 0) +
      (await deleteSelectedBatches(
        'telegram_updates',
        sql<boolean>`
      JSON_UNQUOTE(JSON_EXTRACT(
        CASE WHEN JSON_VALID(JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.payloadJson')))
          THEN JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.payloadJson'))
          ELSE JSON_EXTRACT(data_json, '$.payload') END,
        '$.message.from.id')) = ${id}
      OR JSON_UNQUOTE(JSON_EXTRACT(
        CASE WHEN JSON_VALID(JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.payloadJson')))
          THEN JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.payloadJson'))
          ELSE JSON_EXTRACT(data_json, '$.payload') END,
        '$.callback_query.from.id')) = ${id}`,
      ));
  }
  // Retain only the event-id dedupe key. A replay cannot grant a fresh account an old order.
  const billing =
    await sql`UPDATE billing_events SET data_json = JSON_OBJECT('accountDeleted', TRUE),
    types_json = JSON_OBJECT(), user_id = NULL WHERE user_id = ${Buffer.from(uid)}`.execute(
      database(),
    );
  counts.billing_events_anonymised = Number(billing.numAffectedRows ?? 0);
  counts.capture_owner_summary = await deleteSelectedBatches(
    'capture_owner_summary',
    sql<boolean>`owner_hash = ${createHash('sha256').update(uid).digest('hex')}`,
    true,
    ['week', 'owner_hash'],
  );
  // capture_learning has no uid column. Its keys are derived from the still-present operations.
  counts.capture_learning = await deleteSelectedBatches(
    'capture_learning',
    sql<boolean>`transaction_hash IN (
    SELECT SHA2(CONCAT(${uid}, CHAR(0), CAST(id AS CHAR)), 256) FROM transactions WHERE user_id = ${Buffer.from(uid)}
    UNION SELECT SHA2(CONCAT(${uid}, CHAR(0), 'receipt', CHAR(0), JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.capture.receiptKey'))), 256)
      FROM transactions WHERE user_id = ${Buffer.from(uid)})`,
    true,
    ['transaction_hash'],
  );
  counts.capture_receipt_cache = await deleteSelectedBatches(
    'capture_receipt_cache',
    sql<boolean>`receipt_key IN (
    SELECT JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.capture.receiptKey')) FROM transactions WHERE user_id = ${Buffer.from(uid)}
    UNION SELECT SHA2(CONCAT('device:', JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.capture.receiptKey'))), 256)
      FROM transactions WHERE user_id = ${Buffer.from(uid)})`,
    true,
    ['receipt_key'],
  );
  // Historical import copies must not preserve a deleted user's data in the live database.
  for (const table of ['migration_documents', 'legacy_documents']) {
    const ownerChecks = ['userId', 'uid', 'profileUid', 'targetUid', 'ownerUserId'].map(
      (field) =>
        sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(archive_json, ${`$.fields.${field}.value`})) = ${uid}`,
    );
    const paths = ['profiles', 'userSettings', 'notificationState', 'telegramUsage'].map(
      (entity) => `${entity}/${uid}`,
    );
    for (const household of ownedHouseholds.rows) {
      paths.push(`households/${household.id}`);
      ownerChecks.push(
        sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(archive_json, '$.fields.householdId.value')) = ${household.id}`,
      );
      ownerChecks.push(
        sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(archive_json, '$.fields.userId.value')) = ${`household:${household.id}`}`,
      );
    }
    for (const id of ids) {
      paths.push(`telegramUsers/${id}`, `telegramSessions/${id}`);
      ownerChecks.push(
        sql<boolean>`JSON_UNQUOTE(JSON_EXTRACT(archive_json, '$.fields.chatId.value')) = ${id}`,
      );
    }
    counts[table] = await deleteSelectedBatches(
      table,
      sql<boolean>`path IN (${sql.join(paths)}) OR (${sql.join(ownerChecks, sql` OR `)})`,
      true,
      ['path_hash'],
    );
  }
  await anonymiseCampaigns(uid);
  await scrubArchives(uid, profile.data?.name);
  return counts;
}

export async function purgeRelational(uid: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [table, policy] of Object.entries(relationalDeletionPolicy)) {
    if (policy === 'uid')
      counts[table] = await deleteBatches(table, sql<boolean>`uid = ${Buffer.from(uid)}`, true);
    if (policy === 'scope')
      counts[table] = await deleteBatches(
        table,
        sql<boolean>`scope = ${Buffer.from(`u:${uid}`)}`,
        true,
      );
  }
  return counts;
}

/** Remove paired labels only when the corresponding identity belongs to the deleted account. */
export function clearAccountReferences(
  data: Record<string, any>,
  uid: string,
): Record<string, any> {
  const result = { ...data };
  if (result.createdBy === uid) {
    delete result.createdBy;
    delete result.createdByName;
  }
  if (result.accountOwnerId === uid) {
    delete result.accountOwnerId;
    delete result.accountOwnerName;
  }
  return result;
}

/** Explicit sync writes avoid the push outbox (which also handles cards/transactions). */
export async function cleanHouseholdReferences(
  uid: string,
  householdId: string,
  dissolving: boolean,
): Promise<void> {
  for (const entity of ['cards', 'transactions', 'savingsGoals', 'budgets'] as const) {
    let cursor: Buffer = Buffer.alloc(0);
    while (true) {
      const where =
        entity === 'cards'
          ? sql`(household_id = ${Buffer.from(householdId)} OR family_household_id = ${Buffer.from(householdId)})`
          : sql`household_id = ${Buffer.from(householdId)}`;
      // Select candidates without range locks; lock only their primary keys for the edits.
      const selected = await sql<{ id: Buffer }>`SELECT id FROM ${sql.table(tables[entity])}
        WHERE ${where} AND id > ${cursor} ORDER BY id LIMIT ${DELETION_BATCH_SIZE}`.execute(
        database(),
      );
      if (!selected.rows.length) break;
      await database()
        .transaction()
        .execute(async (tx) => {
          const rows = await sql<{
            id: Buffer;
            data_json: any;
            types_json: any;
          }>`SELECT id, data_json, types_json
          FROM ${sql.table(tables[entity])} WHERE id IN (${sql.join(selected.rows.map((row) => row.id))})
          ORDER BY id FOR UPDATE`.execute(tx);
          const changes: SyncChange[] = [];
          for (const row of rows.rows) {
            const before = decodeData(row.data_json, row.types_json);
            if (
              before.householdId !== householdId &&
              !(entity === 'cards' && before.familyAccess?.householdId === householdId)
            )
              continue;
            const after = clearAccountReferences(before, uid);
            if (dissolving && entity === 'cards' && after.familyAccess?.householdId === householdId)
              delete after.familyAccess;
            if (dissolving && after.householdId === householdId) delete after.householdId;
            if (isDeepStrictEqual(before, after)) continue;
            await tx
              .updateTable(tables[entity])
              .set({ ...encodeData(after), ...projected(after) })
              .where('id', '=', row.id)
              .execute();
            const scope = syncScopeOf(entity, row.id.toString(), after);
            if (scope) changes.push({ scope, entity, id: row.id.toString(), deleted: false });
          }
          await recordSyncChanges(tx, changes);
        });
      cursor = selected.rows.at(-1)!.id;
    }
  }
}

async function anonymiseCampaigns(uid: string): Promise<void> {
  // Campaigns are shared content, even if the deleted admin authored them.
  const predicate = sql<boolean>`${jsonEquals('createdBy', uid)} OR user_id = ${Buffer.from(uid)}`;
  let cursor: Buffer = Buffer.alloc(0);
  while (true) {
    const rows = await sql<{ id: Buffer }>`SELECT id FROM communication_campaigns
      WHERE (${predicate}) AND id > ${cursor} ORDER BY id LIMIT ${DELETION_BATCH_SIZE}`.execute(
      database(),
    );
    if (!rows.rows.length) return;
    await sql`UPDATE communication_campaigns SET data_json = JSON_REMOVE(data_json,
      '$.createdBy', '$.createdByName', '$.userId'), user_id = NULL
      WHERE id IN (${sql.join(rows.rows.map((row) => row.id))})`.execute(database());
    cursor = rows.rows.at(-1)!.id;
  }
}

/** Preserve other households' archives; strip exact identity/name values from typed fields. */
export function scrubArchivedReferences(value: any, uid: string, name?: string): any {
  if (value === uid || (name && value === name)) return undefined;
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'string' && (value.value === uid || (name && value.value === name)))
    return undefined;
  if (value.type === 'map' && value.fields?.userId?.value === uid) return undefined;
  if (Array.isArray(value))
    return value
      .map((item) => scrubArchivedReferences(item, uid, name))
      .filter((item) => item !== undefined);
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, scrubArchivedReferences(item, uid, name)])
      .filter(([, item]) => item !== undefined),
  );
}
async function scrubArchives(uid: string, name?: string): Promise<void> {
  for (const table of ['migration_documents', 'legacy_documents']) {
    let cursor = '';
    try {
      while (true) {
        const rows = await sql<{
          path_hash: string;
          archive_json: any;
        }>`SELECT path_hash, archive_json
          FROM ${sql.table(table)} WHERE path_hash > ${cursor} ORDER BY path_hash LIMIT ${DELETION_BATCH_SIZE}`.execute(
          database(),
        );
        if (!rows.rows.length) break;
        for (const row of rows.rows) {
          const before =
            typeof row.archive_json === 'string' ? JSON.parse(row.archive_json) : row.archive_json;
          const after = scrubArchivedReferences(before, uid, name);
          if (JSON.stringify(before) !== JSON.stringify(after))
            await sql`UPDATE ${sql.table(table)} SET archive_json = CAST(${JSON.stringify(after)} AS JSON)
              WHERE path_hash = ${row.path_hash}`.execute(database());
        }
        cursor = rows.rows.at(-1)!.path_hash;
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw error;
    }
  }
}
