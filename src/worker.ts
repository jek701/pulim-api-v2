import { env } from './config/env';
import { checkDatabase, closeDatabase } from './db/database';
import { startNotificationLoops, type NotificationLoops } from './notifications/loops';
import { logger } from './utils/logger';
import { runCommunicationDispatch } from './communications/repository';

async function main(): Promise<void> {
  if (!env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) {
    logger.info('Worker is disabled by maintenance/background configuration');
    return;
  }
  if (env.NOTIFY_EMBEDDED)
    throw new Error('Standalone worker cannot run with NOTIFY_EMBEDDED=true');
  await checkDatabase();
  let loops: NotificationLoops | null = null;
  let timer: NodeJS.Timeout | null = null;
  let communicationRun: Promise<unknown> | undefined;
  let stopping = false;
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
    await loops?.stop();
    await communicationRun;
    await closeDatabase();
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
void main().catch(async (error) => {
  logger.error({ code: (error as { code?: string }).code }, 'worker.startup_failed');
  await closeDatabase();
  process.exitCode = 1;
});
