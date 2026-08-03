import { db } from '../config/firebase';
import type { Currency } from '../domain/types';
import { env } from '../config/env';
import { getRateToBase } from '../services/fxRates.service';
import { createTelegramTransactionOnce } from '../services/transaction.service';
import { logger } from '../utils/logger';
import { sendMessage } from './client';
import { updateDraft } from './drafts.repository';
import { normalizeLanguage } from './i18n';

let running = false;

async function processDraft(document: FirebaseFirestore.QueryDocumentSnapshot): Promise<void> {
  const data = document.data();
  const now = Date.now();
  if (Number(data.nextAttemptAt ?? 0) > now) return;
  if (Number(data.expiresAtMs ?? 0) <= now) {
    await updateDraft(document.id, { status: 'expired' });
    const language = normalizeLanguage(data.language);
    const text = language === 'uz'
      ? '⚠️ Valyuta kursini olib bo‘lmadi. Operatsiya saqlanmadi.'
      : language === 'en'
        ? '⚠️ The exchange rate remained unavailable. The transaction was not saved.'
        : '⚠️ Курс валюты получить не удалось. Операция не сохранена.';
    await sendMessage(String(data.chatId), text).catch(() => undefined);
    return;
  }
  const draft = data.draft as Record<string, unknown>;
  const currency = draft.currency as Currency;
  const date = Number(draft.date);
  const rate = await getRateToBase(currency, date);
  if (!rate) {
    const attempts = Number(data.attempts ?? 0) + 1;
    const delay = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts, 5));
    await updateDraft(document.id, { attempts, nextAttemptAt: now + delay });
    return;
  }
  const input = {
    ...draft,
    baseAmount: Math.round(Number(draft.amount) * rate),
    fxRate: rate,
    fxRateSource: 'NBU',
  };
  const result = await createTelegramTransactionOnce(
    String(data.userId), input, String(data.operationKey), document.id,
  );
  if (result.created) {
    const language = normalizeLanguage(data.language);
    const text = language === 'uz'
      ? '✅ Valyuta operatsiyasi saqlandi.'
      : language === 'en' ? '✅ The foreign-currency transaction was saved.' : '✅ Валютная операция сохранена.';
    await sendMessage(String(data.chatId), text).catch((error) => {
      logger.warn({ err: error, draftId: document.id }, 'telegram.fx.notification_failed');
    });
  }
}

export async function processFxQueue(): Promise<void> {
  if (running || !env.TELEGRAM_QUICK_ENTRY_ENABLED) return;
  running = true;
  try {
    const snapshot = await db.collection('telegramDrafts')
      .where('status', '==', 'waiting_fx')
      .limit(env.TELEGRAM_FX_RETRY_BATCH_SIZE)
      .get();
    for (const document of snapshot.docs) {
      await processDraft(document).catch((error) => {
        logger.error({ err: error, draftId: document.id }, 'telegram.fx.job_failed');
      });
    }
  } finally {
    running = false;
  }
}

export function startFxQueue(): NodeJS.Timeout {
  void processFxQueue();
  const timer = setInterval(() => void processFxQueue(), env.TELEGRAM_FX_RETRY_INTERVAL_MS);
  timer.unref();
  return timer;
}
