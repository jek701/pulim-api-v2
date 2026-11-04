import { createHash, randomInt } from 'node:crypto';
import { database } from '../db/database';
import { SqlTransaction } from '../db/documents';
import { relationalTables } from '../db/tables';
import { profileRef } from '../repositories/profile.repository';
import { notificationDefaults } from '../notifications/settings';
import type { DeviceRegistration } from './schemas';

export interface PushDevice {
  id: string;
  uid: string;
  token: string;
  platform: 'ios';
  environment: 'sandbox' | 'production';
  bundleId: string;
  appVersion: string;
  buildNumber: string;
  createdAt: number;
  lastSeenAt: number;
  disabledAt: number | null;
  disabledReason: string | null;
}
const TABLE = relationalTables.pushDevices;
function device(row: Record<string, any>): PushDevice {
  return {
    id: String(row.id),
    uid: Buffer.isBuffer(row.uid) ? row.uid.toString() : row.uid,
    token: row.token,
    platform: row.platform,
    environment: row.environment,
    bundleId: row.bundle_id,
    appVersion: row.app_version,
    buildNumber: row.build_number,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    disabledAt: row.disabled_at === null ? null : Number(row.disabled_at),
    disabledReason: row.disabled_reason,
  };
}
const missingTable = (error: unknown) => (error as { code?: string }).code === 'ER_NO_SUCH_TABLE';
export async function enabledDevices(uid: string): Promise<PushDevice[]> {
  try {
    return (
      await database()
        .selectFrom(TABLE)
        .selectAll()
        .where('uid', '=', Buffer.from(uid))
        .where('disabled_at', 'is', null)
        .execute()
    ).map(device);
  } catch (error) {
    // The additive migration is an owner-controlled rollout step. Telegram keeps working.
    if (missingTable(error)) return [];
    throw error;
  }
}
export async function pushActive(uid: string): Promise<boolean> {
  return (await enabledDevices(uid)).length > 0;
}
export async function registerDevice(uid: string, input: DeviceRegistration): Promise<PushDevice> {
  const token = input.token.toLowerCase();
  const id = createHash('sha256').update(token).digest('hex');
  for (let attempt = 0; ; attempt++) {
    try {
      return await database()
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (db) => {
          const now = Date.now();
          const values = {
            id,
            uid: Buffer.from(uid),
            token,
            platform: input.platform,
            environment: input.environment,
            bundle_id: input.bundleId,
            app_version: input.appVersion,
            build_number: input.buildNumber,
            created_at: now,
            last_seen_at: now,
            disabled_at: null,
            disabled_reason: null,
          };
          const { id: _id, created_at: _created, token: _token, ...updated } = values;
          // The unique-token lock serializes simultaneous registrations and transfers ownership.
          await db.insertInto(TABLE).values(values).onDuplicateKeyUpdate(updated).execute();
          const documents = new SqlTransaction(db);
          const ref = profileRef(uid);
          const profile = await documents.read(ref);
          documents.save(
            ref,
            {
              language: input.language,
              timezone: input.timezone,
              notifications: {
                ...(profile.data?.notifications ??
                  notificationDefaults({ ...profile.data, timezone: input.timezone }, now)),
                timezone: input.timezone,
              },
              updatedAt: now,
            },
            { merge: true },
          );
          await documents.flush(db);
          const row = await db
            .selectFrom(TABLE)
            .selectAll()
            .where('token', '=', token)
            .executeTakeFirstOrThrow();
          return device(row);
        });
    } catch (error) {
      if (
        attempt >= 4 ||
        !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(
          (error as { code?: string }).code ?? '',
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, randomInt(10, 50) * (attempt + 1)));
    }
  }
}
export async function unregisterDevice(uid: string, token: string): Promise<void> {
  try {
    await database()
      .deleteFrom(TABLE)
      .where('token', '=', token.toLowerCase())
      .where('uid', '=', Buffer.from(uid))
      .execute();
  } catch (error) {
    if (!missingTable(error)) throw error;
  }
}
export async function disableDevice(
  id: string,
  reason: string,
  lastSeenAt?: number,
): Promise<void> {
  let query = database()
    .updateTable(TABLE)
    .set({ disabled_at: Date.now(), disabled_reason: reason.slice(0, 255) })
    .where('id', '=', id)
    .where('disabled_at', 'is', null);
  // A delayed APNs response must not disable a freshly registered token.
  if (lastSeenAt !== undefined) query = query.where('last_seen_at', '=', lastSeenAt);
  await query.execute();
}
/** Cursor-paged users with native devices, including users without a Telegram chat. */
export async function listPushUserIds(afterUid?: string, limit = 200): Promise<string[]> {
  try {
    let query = database()
      .selectFrom(TABLE)
      .select('uid')
      .distinct()
      .where('disabled_at', 'is', null)
      .orderBy('uid')
      .limit(Math.min(1000, Math.max(1, Math.floor(limit))));
    if (afterUid) query = query.where('uid', '>', Buffer.from(afterUid));
    const rows = await query.execute();
    return rows.map((row) => (Buffer.isBuffer(row.uid) ? row.uid.toString() : String(row.uid)));
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}
