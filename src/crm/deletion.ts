import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { internalSignature } from '../middleware/internalHmac';
import {
  documentKey,
  queryTable,
  saveDocument,
  readDocument,
  runSqlTransaction,
  filterQuery,
  orderQuery,
  limitQuery,
  Timestamp,
} from '../db/documents';
import { logger } from '../utils/logger';

const configured = () => Boolean(env.PULIM_CRM_API_URL && env.PULIM_CRM_INTERNAL_SECRET);
const taskRef = (uid: string) =>
  documentKey(
    queryTable('notificationTasks'),
    `crm-delete:${createHash('sha256').update(uid).digest('hex')}`,
  );
const pending = 'crm_delete_pending';
const hash = (uid: string) => createHash('sha256').update(uid).digest('hex');

/** Written after the last owner sweep, before deleting the profile. No userId projection:
 * this operational tombstone must survive a resumed owner's deletion sweep. */
export async function rememberCrmDeletion(uid: string): Promise<boolean> {
  if (!configured()) return false;
  try {
    const createdAt = Date.now();
    await saveDocument(taskRef(uid), {
      uid, status: pending, createdAt, runAt: createdAt, attempts: 0,
      expiresAt: Timestamp.fromMillis(createdAt + 90 * 86400000),
    });
    return true;
  } catch {
    logger.warn({ uidHash: hash(uid) }, 'crm.deletion.remember_failed');
    return false;
  }
}
export async function sendCrmDeletion(uid: string, timeoutMs = 5000): Promise<boolean> {
  if (!configured()) return true;
  const raw = JSON.stringify({ uid });
  const timestamp = String(Date.now());
  const requestId = randomUUID();
  try {
    const response = await fetch(
      `${env.PULIM_CRM_API_URL!.replace(/\/$/, '')}/internal/v1/users/deleted`,
      {
        method: 'POST',
        body: raw,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Pulim-Timestamp': timestamp,
          'X-Pulim-Request-Id': requestId,
          'X-Pulim-Signature': internalSignature(
            env.PULIM_CRM_INTERNAL_SECRET!,
            timestamp,
            raw,
            requestId,
          ),
        },
      },
    );
    await response.body?.cancel();
    return response.status === 204;
  } catch {
    return false;
  }
}
async function drainOne(uid: string): Promise<void> {
  const ref = taskRef(uid);
  const claimed = await runSqlTransaction(async (tx) => {
    const job = await tx.read(ref);
    const profile = await tx.read(documentKey(queryTable('profiles'), uid));
    // Do not tell the CRM until the account's local data (including the profile) is gone.
    if (!job.exists || job.data.status !== pending) return null;
    const expiresAt = job.data.expiresAt;
    if (expiresAt != null && Number(typeof expiresAt?.toMillis === 'function' ? expiresAt.toMillis() : expiresAt) <= Date.now()) {
      tx.remove(ref);
      return 'expired' as const;
    }
    if (!configured() || Number(job.data.runAt) > Date.now()) return null;
    if (profile.exists) {
      // A genuinely new account may reuse a deterministic Telegram uid. Do not delete its CRM data.
      if (!profile.data.deletionRequestedAt) tx.remove(ref);
      else tx.patch(ref, { runAt: Date.now() + 60000 });
      return null;
    }
    const attempts = Number(job.data.attempts ?? 0) + 1;
    tx.patch(ref, { runAt: Date.now() + 30000, attempts });
    return attempts;
  });
  if (claimed === null) return;
  if (claimed === 'expired') {
    logger.warn({ uidHash: hash(uid) }, 'crm.deletion.expired');
    return;
  }
  const sent = await sendCrmDeletion(uid);
  await runSqlTransaction(async (tx) => {
    const job = await tx.read(ref);
    if (!job.exists || job.data.attempts !== claimed) return;
    if (sent) tx.remove(ref);
    else
      tx.patch(ref, { runAt: Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(claimed, 12)) });
  });
  if (!sent && claimed === 1) logger.warn({ uidHash: hash(uid) }, 'crm.deletion.pending');
}
/** Deletion is successful independently of CRM or outbox availability. */
export async function notifyCrmDeletion(uid: string, remembered: boolean): Promise<void> {
  if (!configured()) return;
  if (remembered) return;
  // Only a failed durable write uses this bounded fallback. A process crash can lose it.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    if (await sendCrmDeletion(uid, 2000)) return;
  }
  logger.warn({ uidHash: hash(uid) }, 'crm.deletion.retry_exhausted');
}
export async function runCrmDeletionFanouts(): Promise<void> {
  if (!env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) return;
  const expired = await readDocument(
    limitQuery(orderQuery(filterQuery(filterQuery(queryTable('notificationTasks'), 'status', '==', pending),
      'expiresAt', '<=', Timestamp.fromMillis(Date.now())), 'expiresAt'), 10),
  );
  for (const row of expired.rows) await drainOne(String(row.data.uid));
  if (!configured()) return;
  const rows = await readDocument(
    limitQuery(
      orderQuery(
        filterQuery(
          filterQuery(queryTable('notificationTasks'), 'status', '==', pending),
          'runAt',
          '<=',
          Date.now(),
        ),
        'runAt',
      ),
      10,
    ),
  );
  for (const row of rows.rows) await drainOne(String(row.data.uid));
}

/** Dedicated drain also works when notification delivery itself is disabled. */
export function startCrmDeletionLoop(unref: boolean): { stop: () => Promise<void> } {
  let stopping = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopping || running) return;
    running = runCrmDeletionFanouts()
      .catch(() => logger.warn('crm.deletion.worker_failed'))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 30000);
  if (unref) timer.unref();
  tick();
  return {
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      await running;
    },
  };
}
