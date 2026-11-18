import { createHash } from 'node:crypto';
import { env } from '../config/env';
import { listPendingAccountDeletions } from '../db/accountDeletion';
import { purgeAccount } from './accountDeletion.service';
import { logger } from '../utils/logger';

export async function runAccountPurges(
  now = Date.now(),
  isStopping = () => false,
): Promise<void> {
  if (!env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE || isStopping()) return;
  const rows = await listPendingAccountDeletions(
    now - env.ACCOUNT_DELETION_GRACE_DAYS * 86400000,
    20,
  );
  for (const { uid } of rows) {
    if (isStopping()) break;
    try {
      await purgeAccount(uid);
    } catch {
      logger.warn({ uidHash: createHash('sha256').update(uid).digest('hex') }, 'account.purge_failed');
    }
  }
}

export function startAccountPurgeLoop(): { stop: () => Promise<void> } {
  let stopping = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopping || running) return;
    running = runAccountPurges(Date.now(), () => stopping)
      .catch(() => logger.warn('account.purge_worker_failed'))
      .finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 3600000);
  tick();
  return {
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      await running;
    },
  };
}
