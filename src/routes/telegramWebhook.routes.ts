import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from '../config/env';
import { dispatchUpdate, telegramUpdateSchema } from '../telegram/dispatcher';
import { abandonUpdate, claimUpdate, completeUpdate, enqueueUpdate, failUpdate, listRecoverableUpdates } from '../telegram/dedupe.repository';
import { logger } from '../utils/logger';
import { sendMessage } from '../telegram/client';
import { resolveUserContext } from '../telegram/context';
import { t } from '../telegram/i18n';

const router = Router();

function secretMatches(received: string | undefined): boolean {
  if (!received) return false;
  const expectedBuffer = Buffer.from(env.TELEGRAM_WEBHOOK_SECRET);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function processUpdate(update: ReturnType<typeof telegramUpdateSchema.parse>): Promise<void> {
  if (!(await claimUpdate(update.update_id))) return;
  try {
    const uid = await dispatchUpdate(update);
    await completeUpdate(update.update_id, uid);
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : 'UNKNOWN';
    await failUpdate(update.update_id, errorCode).catch(() => undefined);
    logger.error({ err: error, updateId: update.update_id }, 'telegram.error');
  }
}

let recovering = false;
export async function recoverTelegramUpdates(): Promise<void> {
  if (recovering || !env.TELEGRAM_QUICK_ENTRY_ENABLED) return;
  recovering = true;
  try {
    const rows = await listRecoverableUpdates();
    for (const row of rows) {
      const parsed = telegramUpdateSchema.safeParse(row.payload);
      if (row.attempts >= 10) {
        await abandonUpdate(row.updateId, 'MAX_ATTEMPTS');
        logger.error({ updateId: row.updateId, attempts: row.attempts }, 'telegram.update.abandoned');
        if (parsed.success && parsed.data.message?.from) {
          const chatId = String(parsed.data.message.chat.id);
          const context = await resolveUserContext(String(parsed.data.message.from.id), chatId).catch(() => null);
          await sendMessage(chatId, t(context?.language ?? 'ru', 'error')).catch(() => undefined);
        }
        continue;
      }
      if (parsed.success) await processUpdate(parsed.data);
      else await abandonUpdate(row.updateId, 'INVALID_STORED_UPDATE');
    }
  } finally {
    recovering = false;
  }
}

router.post('/', async (req, res, next) => {
  try {
    if (!env.TELEGRAM_QUICK_ENTRY_ENABLED) {
      res.status(204).end();
      return;
    }
    if (!secretMatches(req.header('x-telegram-bot-api-secret-token'))) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook secret.' } });
      return;
    }
    const update = telegramUpdateSchema.parse(req.body);
    const updateType = update.callback_query ? 'callback_query' : update.message ? 'message' : 'other';
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;
    logger.info({ updateId: update.update_id, type: updateType, chatId }, 'telegram.update.received');
    const inserted = await enqueueUpdate(update.update_id, update);
    res.status(200).json({ ok: true });
    if (inserted) void processUpdate(update);
  } catch (error) {
    next(error);
  }
});

export const telegramWebhookRouter = router;
