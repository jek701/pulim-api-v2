import { env } from './config/env';
import './config/firebase';
import { startNotificationLoops, type NotificationLoops } from './notifications/loops';
import { logger } from './utils/logger';
import { admin } from './config/firebase';

let loops: NotificationLoops | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let stopping = false;

if (env.NOTIFY_EMBEDDED) {
  logger.error('NOTIFY_EMBEDDED=true: the standalone notification worker must not run');
  process.exitCode = 1;
} else if (!env.NOTIFICATIONS_ENABLED) {
  logger.warn('Notification worker is disabled; waiting idle until notifications are enabled and the process is restarted');
  // Keep PM2 from entering a restart loop during the dark-launch phase.
  idleTimer = setInterval(() => undefined, 60_000);
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
  await Promise.all(admin.apps.map((app) => app?.delete()));
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
