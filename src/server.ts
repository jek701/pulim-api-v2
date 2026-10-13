import { env } from './config/env';
import { createApp } from './app';
import { checkDatabase, closeDatabase } from './db/database';
import { admin } from './config/firebaseAuth';
import { logger } from './utils/logger';
import { setMyCommands, setWebhook } from './telegram/client';
import { startFxQueue } from './telegram/fxQueue.service';
import { drainTelegramUpdates, recoverTelegramUpdates } from './routes/telegramWebhook.routes';
import { startNotificationLoops } from './notifications/loops';

async function main(): Promise<void> {
  await checkDatabase();
  const app = createApp();
  const jobsEnabled = env.BACKGROUND_JOBS_ENABLED && !env.MAINTENANCE_MODE;
  const server = app.listen(env.PORT, env.BIND_HOST, () => {
    logger.info(
      { port: env.PORT, storage: 'mysql', maintenance: env.MAINTENANCE_MODE },
      'pulim-api.started',
    );
    if (jobsEnabled && env.TELEGRAM_QUICK_ENTRY_ENABLED) {
      void setWebhook().catch((error) =>
        logger.error({ err: error }, 'telegram.webhook.setup_failed'),
      );
      void setMyCommands().catch((error) =>
        logger.warn({ err: error }, 'telegram.commands.setup_failed'),
      );
    }
  });
  const fxQueue = jobsEnabled ? startFxQueue() : null;
  let stopping = false;
  let recoveryRun: Promise<void> | undefined;
  const recover = () => {
    if (stopping || recoveryRun) return;
    recoveryRun = recoverTelegramUpdates()
      .catch((error) => logger.error({ err: error }, 'telegram.recovery.failed'))
      .finally(() => {
        recoveryRun = undefined;
      });
  };
  const recoveryTimer = jobsEnabled ? setInterval(recover, 30_000) : null;
  recoveryTimer?.unref();
  if (jobsEnabled) recover();
  const notifications =
    jobsEnabled && env.NOTIFICATIONS_ENABLED && env.NOTIFY_EMBEDDED
      ? startNotificationLoops({ unref: true })
      : null;

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'pulim-api.stopping');
    if (recoveryTimer) clearInterval(recoveryTimer);
    const deadline = setTimeout(() => {
      logger.error('Graceful shutdown timed out; durable jobs will recover on restart');
      process.exit(1);
    }, 60_000);
    deadline.unref();
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        fxQueue?.stop(),
        notifications?.stop(),
        recoveryRun,
      ]);
      await drainTelegramUpdates();
      await closeDatabase();
      await Promise.all(admin.apps.map((app) => app?.delete()));
    } finally {
      clearTimeout(deadline);
    }
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
void main().catch(async (error) => {
  logger.error({ code: (error as { code?: string }).code }, 'pulim-api.startup_failed');
  await closeDatabase();
  process.exitCode = 1;
});
