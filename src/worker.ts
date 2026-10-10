import { env } from './config/env';
import './config/firebase';
import { startNotificationLoops, type NotificationLoops } from './notifications/loops';
import { logger } from './utils/logger';
import { admin } from './config/firebase';
import { runCommunicationDispatch } from './communications/repository';

let loops: NotificationLoops | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let communicationRun: Promise<unknown> | undefined;
let stopping = false;

const dispatchCommunications = () => {
  if (stopping || communicationRun) return;
  communicationRun = runCommunicationDispatch()
    .catch((error) => logger.error({ err: error }, 'communications.dispatch.failed'))
    .finally(() => { communicationRun = undefined; });
};

if (env.NOTIFY_EMBEDDED) {
  logger.error('NOTIFY_EMBEDDED=true: the standalone notification worker must not run');
  process.exitCode = 1;
} else if (!env.NOTIFICATIONS_ENABLED) {
  logger.warn('Financial notifications are disabled; running communications dispatch only');
  idleTimer = setInterval(dispatchCommunications, 30_000);
  dispatchCommunications();
} else {
  loops = startNotificationLoops({ unref: false });
  logger.info('Pulim notification worker started');
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down notification worker');
  if (idleTimer) clearInterval(idleTimer);
  await loops?.stop();
  await Promise.allSettled(communicationRun ? [communicationRun] : []);
  await Promise.all(admin.apps.map((app) => app?.delete()));
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
