import { env } from '../../config/env';
import { getIsPremium } from '../../services/entitlement.service';
import { logger } from '../../utils/logger';
import { deleteMessage, sendChatAction, sendMessage } from '../client';
import { resolveUserContext, type TelegramUserContext } from '../context';
import { languageFromTelegram, t, type MessageKey } from '../i18n';
import { transcribeVoice } from '../media.service';
import { processReceipt } from '../quickEntry.service';
import { escapeHtml, loginKeyboard, openAppKeyboard, premiumKeyboard } from '../render';
import { consumeParse, refundParse } from '../usage.repository';
import { handleTextMessage } from './message.handler';

interface MediaInput {
  updateId: number;
  messageId: number;
  chatId: string;
  telegramId: string;
  languageCode?: string;
}

/**
 * Shared gate for paid media features: the account must be linked, quick entry
 * enabled and the user Premium. Otherwise the user gets an explanation (with a
 * direct Premium purchase button) and the update is finished.
 */
async function premiumMediaContext(
  input: MediaInput,
  premiumMessage: MessageKey,
): Promise<{ context: TelegramUserContext | null; allowed: boolean }> {
  const context = await resolveUserContext(input.telegramId, input.chatId);
  if (!context) {
    const language = languageFromTelegram(input.languageCode);
    await sendMessage(input.chatId, t(language, 'not_linked'), { reply_markup: loginKeyboard(language) });
    return { context: null, allowed: false };
  }
  if (context.profile.telegramQuickEntryEnabled === false) {
    await sendMessage(input.chatId, t(context.language, 'disabled'), { reply_markup: openAppKeyboard(context.language) });
    return { context, allowed: false };
  }
  if (!(await getIsPremium(context.uid))) {
    await sendMessage(input.chatId, t(context.language, premiumMessage), {
      reply_markup: premiumKeyboard(context.language),
      reply_parameters: { message_id: input.messageId, allow_sending_without_reply: true },
    });
    return { context, allowed: false };
  }
  return { context, allowed: true };
}

/** Consumes the daily bot quota for this update; the text pipeline reuses the same key, so it is counted once. */
async function consumeMediaQuota(input: MediaInput, context: TelegramUserContext): Promise<boolean> {
  const limit = await consumeParse(context.uid, String(input.updateId), true);
  if (!limit) return true;
  await sendMessage(input.chatId, t(context.language, limit === 'minute' ? 'rate_minute' : 'rate_day'));
  return false;
}

export async function handleVoiceMessage(input: MediaInput & {
  fileId: string;
  duration: number;
}): Promise<string | null> {
  const { context, allowed } = await premiumMediaContext(input, 'premium_voice_required');
  if (!context || !allowed) return context?.uid ?? null;
  if (input.duration > env.TELEGRAM_VOICE_MAX_SECONDS) {
    await sendMessage(input.chatId, t(context.language, 'voice_too_long'));
    return context.uid;
  }
  if (!(await consumeMediaQuota(input, context))) return context.uid;

  await sendChatAction(input.chatId, 'typing').catch(() => undefined);
  let text: string;
  try {
    text = await transcribeVoice(context.uid, input.fileId);
  } catch (error) {
    logger.warn({ err: error, uid: context.uid }, 'telegram.voice.transcription_failed');
    text = '';
  }
  if (!text) {
    await refundParse(context.uid, String(input.updateId));
    await sendMessage(input.chatId, t(context.language, 'voice_failed'));
    return context.uid;
  }
  logger.info({ uid: context.uid, chars: text.length }, 'telegram.voice.transcribed');
  await sendMessage(input.chatId, `🎙 <i>${escapeHtml(text)}</i>`, {
    reply_parameters: { message_id: input.messageId, allow_sending_without_reply: true },
  });
  return handleTextMessage({ ...input, text });
}

export async function handleReceiptPhoto(input: MediaInput & { fileId: string }): Promise<string | null> {
  const { context, allowed } = await premiumMediaContext(input, 'premium_receipt_required');
  if (!context || !allowed) return context?.uid ?? null;
  if (!(await consumeMediaQuota(input, context))) return context.uid;

  const reading = await sendMessage(input.chatId, t(context.language, 'receipt_reading'), {
    reply_parameters: { message_id: input.messageId, allow_sending_without_reply: true },
  }).catch(() => null);
  let recognised = false;
  try {
    recognised = await processReceipt({
      uid: context.uid,
      chatId: input.chatId,
      messageId: input.messageId,
      updateId: input.updateId,
      fileId: input.fileId,
      language: context.language,
      isPremium: true,
    });
  } catch (error) {
    logger.warn({ err: error, uid: context.uid }, 'telegram.receipt.failed');
  } finally {
    if (reading) await deleteMessage(input.chatId, reading.message_id).catch(() => undefined);
  }
  if (!recognised) {
    await refundParse(context.uid, String(input.updateId));
    await sendMessage(input.chatId, t(context.language, 'receipt_failed'), {
      reply_parameters: { message_id: input.messageId, allow_sending_without_reply: true },
    });
  }
  return context.uid;
}
