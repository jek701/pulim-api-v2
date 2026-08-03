import { env } from './config/env';
import './config/firebase'; // initialise Firebase Admin at boot (fail fast on bad creds)
import { createApp } from './app';
import { logger } from './utils/logger';
import { setMyCommands, setWebhook } from './telegram/client';
import { startFxQueue } from './telegram/fxQueue.service';
import { recoverTelegramUpdates } from './routes/telegramWebhook.routes';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`pulim-api listening on :${env.PORT} (${env.NODE_ENV})`);
  if (env.TELEGRAM_QUICK_ENTRY_ENABLED) {
    void setWebhook()
      .then(() => logger.info({ url: env.TELEGRAM_WEBHOOK_URL }, 'telegram.webhook.configured'))
      .catch((error) => logger.error({ err: error }, 'telegram.webhook.setup_failed'));
    void setMyCommands().catch((error) => logger.warn({ err: error }, 'telegram.commands.setup_failed'));
  }
});
const fxQueueTimer = startFxQueue();
const telegramRecoveryTimer = setInterval(() => void recoverTelegramUpdates(), 30_000);
telegramRecoveryTimer.unref();
void recoverTelegramUpdates();

function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down`);
  clearInterval(fxQueueTimer);
  clearInterval(telegramRecoveryTimer);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
