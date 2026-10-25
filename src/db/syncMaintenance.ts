import { sql } from 'kysely';
import { database } from './database';
import { isSyncEnabled, pruneSyncTombstones } from './syncIndex';
import { logger } from '../utils/logger';

export const TOMBSTONE_RETENTION_MS = 90 * 86_400_000;

/** Delete expired idempotency markers in small batches (no TTL job exists for `expires_at_ms`). */
export async function pruneExpiredIdempotencyKeys(now = Date.now()): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < 20; batch++) {
    const result = await sql`DELETE FROM idempotency_keys WHERE expires_at_ms < ${now} LIMIT 1000`.execute(
      database(),
    );
    const count = Number(result.numAffectedRows ?? 0);
    removed += count;
    if (count < 1000) break;
  }
  return removed;
}

export async function runSyncMaintenance(): Promise<void> {
  if (!isSyncEnabled()) return;
  const tombstones = await pruneSyncTombstones(database(), TOMBSTONE_RETENTION_MS);
  const markers = await pruneExpiredIdempotencyKeys();
  if (tombstones || markers) logger.info({ tombstones, markers }, 'offline-sync.maintenance');
}

/** Safe to run in several processes at once; first run shortly after boot, then every 6 hours. */
export function startSyncMaintenance(): { stop: () => void } {
  const run = () =>
    void runSyncMaintenance().catch((error) =>
      logger.warn({ err: error }, 'offline-sync.maintenance.failed'),
    );
  const first = setTimeout(run, 5 * 60_000);
  const timer = setInterval(run, 6 * 3_600_000);
  first.unref();
  timer.unref();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
