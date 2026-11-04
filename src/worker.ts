import { env } from './config/env';
import { checkDatabase, closeDatabase, database } from './db/database';
import { initOfflineSync } from './db/syncIndex';
import { startNotificationLoops, type NotificationLoops } from './notifications/loops';
import { logger } from './utils/logger';
import { runCommunicationDispatch } from './communications/repository';
import { closeApns } from './push/apns';
import { drainPushKicks } from './push/kick';
import { runMerchantSummary } from './capture/owner';

async function main(): Promise<void> {
  if (!env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) {
    logger.info('Worker is disabled by maintenance/background configuration');
    return;
  }
  if (env.NOTIFY_EMBEDDED)
    throw new Error('Standalone worker cannot run with NOTIFY_EMBEDDED=true');
  await checkDatabase();
  const syncOn = await initOfflineSync(database());
  logger.info({ offlineSync: syncOn }, 'offline-sync.state');
  let loops: NotificationLoops | null = null;
  let timer: NodeJS.Timeout | null = null;
  let communicationRun: Promise<unknown> | undefined;
  let stopping = false;
  let merchantRun: Promise<void> | undefined;
  const merchantTick = () => {
    if (stopping || merchantRun) return;
    merchantRun = runMerchantSummary().catch(() => logger.warn('capture.owner_summary_failed'))
      .finally(() => { merchantRun = undefined; });
  };
  const merchantTimer = setInterval(merchantTick, 60_000);
  merchantTick();
  const dispatch = () => {
    if (stopping || communicationRun) return;
    communicationRun = runCommunicationDispatch()
      .catch((error) => logger.error({ err: error }, 'communications.dispatch.failed'))
      .finally(() => {
        communicationRun = undefined;
      });
  };
  if (env.NOTIFICATIONS_ENABLED) loops = startNotificationLoops({ unref: false });
  else {
    timer = setInterval(dispatch, 30_000);
    dispatch();
  }
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker.stopping');
    if (timer) clearInterval(timer);
    clearInterval(merchantTimer);
    try {
      await Promise.all([loops?.stop(), communicationRun, merchantRun, drainPushKicks()]);
      await closeDatabase();
    } finally {
      closeApns();
    }
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
void main().catch(async (error) => {
  logger.error({ code: (error as { code?: string }).code }, 'worker.startup_failed');
  closeApns();
  await closeDatabase();
  process.exitCode = 1;
});
