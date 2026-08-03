import { env } from '../../config/env';
import { getIsPremium } from '../../services/entitlement.service';
import { logger } from '../../utils/logger';
import { deleteMessage, editMessageText, sendMessage } from '../client';
import { resolveUserContext } from '../context';
import { t } from '../i18n';
import { escapeHtml, openAppKeyboard, premiumKeyboard } from '../render';
import { consumeParse, refundParse } from '../usage.repository';
import { processQuickEntry, TelegramChatError } from '../quickEntry.service';
import { clearSession, getSession } from '../sessions.repository';
import { resolveAmount } from '../resolve/amount';
import { parseUserDate } from '../resolve/date';
import { db } from '../../config/firebase';
import { updateTransaction } from '../../services/transaction.service';
import { getOwnedDraft, updateDraft } from '../drafts.repository';
import type { DraftReason } from '../types';
import type { Currency } from '../../domain/types';
import { TelegramParseError } from '../parser.service';
import { AppError } from '../../utils/AppError';
import {
  detectMessageLanguage,
  startBudgetLoadingMessage,
  type BudgetLoadingMessage,
} from '../loadingDraft.service';

export async function handleTextMessage(input: {
  updateId: number;
  messageId: number;
  chatId: string;
  telegramId: string;
  text: string;
}): Promise<string | null> {
  const context = await resolveUserContext(input.telegramId, input.chatId);
  if (!context) {
    await sendMessage(input.chatId, t('ru', 'not_linked'), { reply_markup: openAppKeyboard('ru') });
    return null;
  }
  if (context.profile.telegramQuickEntryEnabled === false) {
    await sendMessage(input.chatId, t(context.language, 'disabled'), {
      reply_markup: openAppKeyboard(context.language),
    });
    return context.uid;
  }
  if (!(await getIsPremium(context.uid))) {
    logger.info({ uid: context.uid }, 'telegram.premium.blocked');
    await sendMessage(input.chatId, t(context.language, 'premium_required'), {
      reply_markup: premiumKeyboard(context.language),
    });
    return context.uid;
  }
  const session = await getSession(input.chatId);
  if (session && session.userId === context.uid && session.draftId) {
    const draft = await getOwnedDraft(String(session.draftId), context.uid);
    if (!draft || draft.status !== 'pending') {
      await clearSession(input.chatId);
      await sendMessage(input.chatId, t(context.language, 'error'));
      return context.uid;
    }
    const transaction = { ...(draft.draft as Record<string, unknown>) };
    let reasons = [...(draft.reasons as DraftReason[])];
    if (session.field === 'amount') {
      const amount = resolveAmount(input.text, Number(input.text), transaction.currency as Currency);
      if (!Number.isFinite(amount.amount) || amount.amount <= 0 || amount.ambiguous) {
        await sendMessage(input.chatId, t(context.language, 'invalid_amount'));
        return context.uid;
      }
      transaction.amount = amount.amount;
      if (transaction.currency !== 'UZS' && Number(transaction.fxRate) > 0) {
        transaction.baseAmount = Math.round(amount.amount * Number(transaction.fxRate));
      }
      reasons = reasons.filter((reason) => !['AMBIGUOUS_SMALL_AMOUNT', 'AMOUNT_MISMATCH', 'LOW_AMOUNT_CONFIDENCE'].includes(reason));
    } else if (session.field === 'comment') {
      transaction.comment = input.text.trim().slice(0, 200);
    } else {
      const date = parseUserDate(input.text, Date.now(), env.TELEGRAM_DEFAULT_TIMEZONE);
      if (!Number.isFinite(date.date)) {
        await sendMessage(input.chatId, t(context.language, 'invalid_date'));
        return context.uid;
      }
      transaction.date = date.date;
      reasons = reasons.filter((reason) => reason !== 'DATE_IN_FUTURE');
    }
    const waitingFx = reasons.length === 1 && reasons[0] === 'FX_UNAVAILABLE';
    await updateDraft(String(session.draftId), {
      draft: transaction,
      reasons,
      ...(waitingFx ? { status: 'waiting_fx', nextAttemptAt: Date.now() } : {}),
    });
    await clearSession(input.chatId);
    await deleteMessage(input.chatId, Number(session.promptMessageId)).catch(() => undefined);
    await editMessageText(input.chatId, Number(session.contextMessageId),
      waitingFx
        ? t(context.language, 'fx_waiting')
        : `${t(context.language, 'draft_updated')}\n\n${escapeHtml(transaction.comment ?? draft.sourceText)} — ${escapeHtml(transaction.amount)} ${escapeHtml(transaction.currency)}`,
      { reply_markup: { inline_keyboard: waitingFx ? [] : [[{ text: t(context.language, 'edit'), callback_data: 'v1:edit:0' }]] } },
    );
    return context.uid;
  }
  if (session && session.userId === context.uid && session.transactionId) {
    const transactionSnap = await db.collection('transactions').doc(String(session.transactionId)).get();
    if (!transactionSnap.exists || transactionSnap.data()!.userId !== context.uid) {
      await clearSession(input.chatId);
      await sendMessage(input.chatId, t(context.language, 'error'));
      return context.uid;
    }
    const transaction = transactionSnap.data()!;
    let patch: Record<string, unknown>;
    if (session.field === 'amount') {
      const amount = resolveAmount(input.text, Number(input.text), transaction.currency);
      if (!Number.isFinite(amount.amount) || amount.amount <= 0 || amount.ambiguous) {
        await sendMessage(input.chatId, t(context.language, 'invalid_amount'));
        return context.uid;
      }
      patch = {
        amount: amount.amount,
        ...(transaction.currency !== 'UZS' && transaction.fxRate
          ? { baseAmount: Math.round(amount.amount * Number(transaction.fxRate)) }
          : {}),
      };
    } else if (session.field === 'comment') {
      patch = { comment: input.text.trim().slice(0, 200) };
    } else {
      const date = parseUserDate(input.text, Date.now(), env.TELEGRAM_DEFAULT_TIMEZONE);
      if (!Number.isFinite(date.date)) {
        await sendMessage(input.chatId, t(context.language, 'invalid_date'));
        return context.uid;
      }
      patch = { date: date.date };
    }
    const updated = await updateTransaction(context.uid, String(session.transactionId), patch);
    await clearSession(input.chatId);
    await deleteMessage(input.chatId, Number(session.promptMessageId)).catch(() => undefined);
    await editMessageText(input.chatId, Number(session.contextMessageId),
      `${t(context.language, 'updated')}\n\n${escapeHtml(updated.comment ?? t(context.language, 'operation'))} — ${escapeHtml(updated.amount)} ${escapeHtml(updated.currency)}`,
      { reply_markup: { inline_keyboard: [[{
        text: t(context.language, 'edit'), callback_data: `v1:edit:${Number(session.itemIndex ?? 0)}`,
      }]] } },
    );
    return context.uid;
  }
  if (input.text.length > env.TELEGRAM_MAX_MESSAGE_CHARS) {
    await sendMessage(input.chatId, t(context.language, 'too_long'));
    return context.uid;
  }

  let loadingMessage: BudgetLoadingMessage | undefined;
  try {
    loadingMessage = await startBudgetLoadingMessage({
      chatId: input.chatId,
      replyToMessageId: input.messageId,
      language: detectMessageLanguage(input.text, context.language),
    });
  } catch (error) {
    logger.debug({ err: error, uid: context.uid }, 'telegram.loading_message.unavailable');
  }
  const replaceLoading = async (text: string) => {
    await loadingMessage?.stop();
    if (loadingMessage) {
      try {
        await editMessageText(input.chatId, loadingMessage.messageId, text);
        return;
      } catch (error) {
        logger.debug({ err: error, uid: context.uid }, 'telegram.loading_message.replace_failed');
      }
    }
    await sendMessage(input.chatId, text, {
      reply_parameters: { message_id: input.messageId, allow_sending_without_reply: true },
    });
  };

  const parseOperationKey = String(input.updateId);
  let limit: 'minute' | 'day' | null;
  try {
    limit = await consumeParse(context.uid, parseOperationKey);
  } catch (error) {
    await loadingMessage?.stop();
    if (loadingMessage) await deleteMessage(input.chatId, loadingMessage.messageId).catch(() => undefined);
    throw error;
  }
  if (limit) {
    await replaceLoading(t(context.language, limit === 'minute' ? 'rate_minute' : 'rate_day'));
    return context.uid;
  }
  try {
    await processQuickEntry({ ...input, uid: context.uid, language: context.language, loadingMessage });
  } catch (error) {
    if (error instanceof TelegramParseError) {
      await refundParse(context.uid, parseOperationKey);
      logger.warn({ uid: context.uid, err: error.cause }, 'telegram.parse.failed');
      await replaceLoading(t(context.language, 'parse_failed'));
      return context.uid;
    }
    if (error instanceof TelegramChatError) {
      logger.warn({ uid: context.uid, err: error.cause }, 'telegram.chat.failed');
      await replaceLoading(t(context.language, 'error'));
      return context.uid;
    }
    if (error instanceof AppError && ['AI_FAIR_USE_LIMIT_REACHED', 'AI_LIMIT_REACHED'].includes(error.code)) {
      await replaceLoading(t(context.language, 'rate_day'));
      return context.uid;
    }
    await loadingMessage?.stop();
    throw error;
  }
  return context.uid;
}
