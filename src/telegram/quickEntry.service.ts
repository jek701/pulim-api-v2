import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { env } from '../config/env';
import { db } from '../config/firebase';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories';
import type { Card, Category, Subcategory, Transaction } from '../domain/types';
import {
  answerStatelessChat, assembleSnapshot, consumeAiMessage, refundAiMessage, selectChatModel,
} from '../services/ai.service';
import { getRateToBase } from '../services/fxRates.service';
import { createTelegramTransactionOnce } from '../services/transaction.service';
import { logger } from '../utils/logger';
import { aliasesForCategory, categoryDisplayName } from './categoryAliases';
import { deleteMessage, editMessageText, sendMessage, sendMessageDraft } from './client';
import { createDraft, updateDraft } from './drafts.repository';
import { t } from './i18n';
import type { BudgetLoadingMessage } from './loadingDraft.service';
import { parseMessage, TelegramParseError } from './parser.service';
import { escapeHtml, markdownToTelegramHtml } from './render';
import { saveMessage } from './messages.repository';
import { resolveAmount } from './resolve/amount';
import { resolveCard } from './resolve/card';
import { resolveCategory } from './resolve/category';
import { resolveDate } from './resolve/date';
import type { DraftReason, SupportedLanguage } from './types';

dayjs.extend(utc);
dayjs.extend(timezone);

const owned = async <T>(collection: string, uid: string): Promise<T[]> => {
  const snapshot = await db.collection(collection).where('userId', '==', uid).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as T);
};

const clean = (value: unknown) => String(value ?? '').replace(/[\r\n|]+/g, ' ').trim();
const isDefault = (category: Category) => DEFAULT_CATEGORIES.some((candidate) =>
  candidate.name === category.name && candidate.icon === category.icon && candidate.type === category.type);

export class TelegramChatError extends Error {
  override name = 'TelegramChatError';
  constructor(public override readonly cause: unknown) {
    super('Telegram stateless chat failed.');
  }
}

async function loadCatalog(uid: string, language: SupportedLanguage) {
  const cutoff = Date.now() - 90 * 86_400_000;
  const [categories, subcategories, cards, transactions] = await Promise.all([
    owned<Category>('categories', uid),
    owned<Subcategory>('subcategories', uid),
    owned<Card>('cards', uid),
    owned<Transaction>('transactions', uid),
  ]);
  const recent = transactions.filter((transaction) => transaction.date >= cutoff)
    .sort((a, b) => b.date - a.date || b.createdAt - a.createdAt);
  const recentCardIds = [...new Set(recent.map((transaction) => transaction.cardId).filter(Boolean))] as string[];
  const rank = new Map(recentCardIds.map((id, index) => [id, index + 1]));
  const today = dayjs().tz(env.TELEGRAM_DEFAULT_TIMEZONE);
  const lines = [
    `TODAY: ${today.format('YYYY-MM-DD (dddd)')}, timezone ${env.TELEGRAM_DEFAULT_TIMEZONE}`,
    'BASE_CURRENCY: UZS',
    `USER_LANGUAGE: ${language}`,
    '',
    'CATEGORIES (id | type | name | aliases):',
    ...categories.map((category) => [
      category.id, category.type, clean(category.name),
      isDefault(category) ? aliasesForCategory(category.name).map(clean).join(', ') : '',
    ].join(' | ')),
    '',
    'SUBCATEGORIES (id | categoryId | name):',
    ...subcategories.map((subcategory) => [subcategory.id, subcategory.categoryId, clean(subcategory.name)].join(' | ')),
    '',
    'CARDS (id | name | bank | type | currency | balance | availableLimit | lastUsedRank):',
    ...cards.map((card) => [
      card.id, clean(card.name), clean(card.bank), card.cardType, card.currency, card.balance,
      card.cardType === 'credit' ? (card.limit ?? 0) - card.balance : '-', rank.get(card.id) ?? '-',
    ].join(' | ')),
  ];
  return { categories, subcategories, cards, recentCardIds, prompt: lines.join('\n') };
}

function formatAmount(amount: number, currency: string, language: SupportedLanguage): string {
  const locale = language === 'uz' ? 'uz-UZ' : language === 'en' ? 'en-US' : 'ru-RU';
  const unit = currency === 'UZS' ? (language === 'uz' ? "so‘m" : language === 'en' ? 'UZS' : 'сум') : currency;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)} ${unit}`;
}

const localized = (language: SupportedLanguage, ru: string, uz: string, en: string) =>
  language === 'uz' ? uz : language === 'en' ? en : ru;

function looksLikeGreeting(text: string): boolean {
  return /^(привет|здравствуй|салом|salom|hello|hi|hey)[!.,\s]*$/iu.test(text.trim());
}

async function answerNonTransaction(
  uid: string,
  chatId: string,
  text: string,
  language: SupportedLanguage,
  updateId: number,
  inputMessageId: number,
  loadingMessage?: BudgetLoadingMessage,
) {
  if (looksLikeGreeting(text)) {
    await loadingMessage?.stop();
    if (loadingMessage) await editMessageText(chatId, loadingMessage.messageId, t(language, 'welcome'));
    else await sendMessage(chatId, t(language, 'welcome'), {
      reply_parameters: { message_id: inputMessageId, allow_sending_without_reply: true },
    });
    return;
  }
  await consumeAiMessage(uid, true);
  const draftId = Math.abs(updateId % 2_147_483_647) || 1;
  try {
    const snapshot = await assembleSnapshot(uid, language);
    let lastDraftAt = 0;
    let loadingStopped = false;
    const answer = await answerStatelessChat({
      uid, model: selectChatModel(true), snapshot, language, userMessage: text,
      signal: AbortSignal.timeout(env.TELEGRAM_PARSE_TIMEOUT_MS),
      onDelta: async (_delta, fullText) => {
        if (!loadingStopped) {
          loadingStopped = true;
          await loadingMessage?.stop();
        }
        const now = Date.now();
        if (now - lastDraftAt < 350) return;
        lastDraftAt = now;
        const rendered = markdownToTelegramHtml(fullText.slice(0, 4_000));
        const update = loadingMessage
          ? editMessageText(chatId, loadingMessage.messageId, rendered)
          : sendMessageDraft(chatId, draftId, rendered);
        await update
          .catch((error) => logger.debug({ err: error, uid }, 'telegram.draft_stream.update_failed'));
      },
    });
    if (!loadingStopped) await loadingMessage?.stop();
    const rendered = markdownToTelegramHtml(answer.slice(0, 4_000));
    if (loadingMessage) await editMessageText(chatId, loadingMessage.messageId, rendered);
    else await sendMessage(chatId, rendered, {
      reply_parameters: { message_id: inputMessageId, allow_sending_without_reply: true },
    });
  } catch (error) {
    await loadingMessage?.stop();
    await refundAiMessage(uid, true);
    throw new TelegramChatError(error);
  }
}

export async function processQuickEntry(input: {
  uid: string;
  chatId: string;
  messageId: number;
  updateId: number;
  text: string;
  language: SupportedLanguage;
  loadingMessage?: BudgetLoadingMessage;
}): Promise<void> {
  const catalog = await loadCatalog(input.uid, input.language);
  const parsed = await parseMessage(input.uid, input.text, catalog.prompt);
  if (!parsed.isTransactionMessage) {
    await answerNonTransaction(
      input.uid,
      input.chatId,
      input.text,
      input.language,
      input.updateId,
      input.messageId,
      input.loadingMessage,
    );
    return;
  }
  await input.loadingMessage?.stop();
  if (input.loadingMessage) {
    await deleteMessage(input.chatId, input.loadingMessage.messageId).catch(() => undefined);
  }
  if (parsed.items.length === 0) throw new TelegramParseError(new Error('Parser returned no transaction items.'));

  const saved: Array<{ transactionId: string; cardId?: string; label: string }> = [];
  const invalidAmounts: string[] = [];
  for (const [index, item] of parsed.items.slice(0, env.TELEGRAM_MAX_ITEMS_PER_MESSAGE).entries()) {
    const amount = resolveAmount(item.amountLiteral, item.amount, item.currency);
    if (!Number.isFinite(amount.amount) || amount.amount <= 0 || amount.amount > 1e15) {
      invalidAmounts.push(item.rawText);
      continue;
    }
    const date = resolveDate(item.dateISO, Date.now(), env.TELEGRAM_DEFAULT_TIMEZONE);
    const category = resolveCategory(item, catalog.categories, catalog.subcategories, input.language);
    const card = resolveCard(item, catalog.cards, catalog.recentCardIds, amount.amount, amount.currency, item.type);
    const reasons: DraftReason[] = [];
    if (amount.reason) reasons.push(amount.reason);
    if (item.amountConfidence < 0.9) reasons.push('LOW_AMOUNT_CONFIDENCE');
    if (category.reason) reasons.push(category.reason);
    if (item.typeConfidence < 0.9) reasons.push('AMBIGUOUS_TYPE');
    if (date.reason) reasons.push(date.reason);
    if (card.reason && card.reason !== 'NO_CARDS') reasons.push(card.reason);

    const transaction: Record<string, unknown> = {
      type: item.type,
      amount: amount.amount,
      currency: amount.currency,
      categoryId: category.categoryId,
      ...(category.subcategoryId ? { subcategoryId: category.subcategoryId } : {}),
      ...(card.cardId ? { cardId: card.cardId } : {}),
      comment: item.comment.slice(0, 80),
      date: date.date,
    };
    if (amount.currency !== 'UZS') {
      const rate = await getRateToBase(amount.currency, date.date);
      if (rate) Object.assign(transaction, {
        baseAmount: Math.round(amount.amount * rate), fxRate: rate, fxRateSource: 'NBU',
      });
      else reasons.push('FX_UNAVAILABLE');
    }

    const operationKey = `${input.updateId}:${index + 1}`;
    if (reasons.length === 0) {
      const result = await createTelegramTransactionOnce(input.uid, transaction, operationKey);
      if (result.created) logger.info({
        uid: input.uid,
        transactionId: result.transaction.id,
        categoryId: transaction.categoryId,
        cardId: transaction.cardId,
        amount: transaction.amount,
        currency: transaction.currency,
      }, 'telegram.tx.autosaved');
      saved.push({
        transactionId: String(result.transaction.id),
        ...(transaction.cardId ? { cardId: String(transaction.cardId) } : {}),
        label: `${escapeHtml(item.comment || item.rawText)} — ${formatAmount(amount.amount, amount.currency, input.language)}`,
      });
      continue;
    }

    const onlyFxUnavailable = reasons.length === 1 && reasons[0] === 'FX_UNAVAILABLE';
    const draft = await createDraft({
      userId: input.uid, chatId: input.chatId, sourceMessageId: input.messageId,
      sourceText: item.rawText, index: index + 1, operationKey, draft: transaction,
      amountAlternative: amount.alternative ?? (amount.reason === 'AMOUNT_MISMATCH' ? item.amount : null),
      suggestion: category.categoryId ? null : {
        categoryName: item.suggestedCategoryName.slice(0, 40),
        categoryIcon: item.suggestedCategoryIcon.slice(0, 8),
      },
      reasons,
      status: onlyFxUnavailable ? 'waiting_fx' : 'pending',
    });
    logger.info({ uid: input.uid, draftId: draft.id, reasons }, 'telegram.draft.created');
    if (onlyFxUnavailable) {
      if (!draft.botMessageId) {
        const sent = await sendMessage(input.chatId, t(input.language, 'fx_waiting'));
        await updateDraft(draft.id, { botMessageId: sent.message_id, language: input.language });
      }
    } else {
      if (draft.botMessageId) continue;
      const categoryIds = catalog.categories.filter((candidate) =>
        candidate.type === item.type || candidate.type === 'both').map((candidate) => candidate.id);
      const cardIds = catalog.cards.map((candidate) => candidate.id);
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      const amountAlternative = amount.alternative ?? (amount.reason === 'AMOUNT_MISMATCH' ? item.amount : null);
      if (amount.reason && amountAlternative) {
        keyboard.push([
          { text: formatAmount(amount.amount, amount.currency, input.language), callback_data: 'v1:amt:0:0' },
          { text: formatAmount(amountAlternative, amount.currency, input.language), callback_data: 'v1:amt:0:1' },
        ]);
      }
      if (!category.categoryId) {
        categoryIds.slice(0, 6).forEach((id, optionIndex) => {
          const candidate = catalog.categories.find((entry) => entry.id === id)!;
          keyboard.push([{ text: `${candidate.icon} ${categoryDisplayName(candidate, input.language)}`, callback_data: `v1:cat:0:${optionIndex}` }]);
        });
        if (item.suggestedCategoryName) keyboard.push([{
          text: `➕ ${item.suggestedCategoryName}`,
          callback_data: 'v1:newcat:0',
        }]);
        if (categoryIds.length > 6) keyboard.push([{
          text: localized(input.language, '⬇️ Ещё', '⬇️ Yana', '⬇️ More'), callback_data: 'v1:txcatp:0:1',
        }]);
      }
      if (card.reason === 'INSUFFICIENT_FUNDS' || card.reason === 'NO_CARD_IN_CURRENCY' || card.reason === 'AMBIGUOUS_CARD_HINT') {
        cardIds.slice(0, 6).forEach((id, optionIndex) => {
          const candidate = catalog.cards.find((entry) => entry.id === id)!;
          keyboard.push([{ text: `💳 ${candidate.name}`, callback_data: `v1:card:0:${optionIndex}` }]);
        });
        if (cardIds.length > 6) keyboard.push([{
          text: localized(input.language, '⬇️ Ещё', '⬇️ Yana', '⬇️ More'), callback_data: 'v1:txcardp:0:1',
        }]);
      }
      const hardReason = reasons.some((reason) => ['AMBIGUOUS_SMALL_AMOUNT', 'AMOUNT_MISMATCH', 'NO_CATEGORY_MATCH', 'NO_CARD_IN_CURRENCY', 'AMBIGUOUS_CARD_HINT', 'FX_UNAVAILABLE'].includes(reason));
      if (!hardReason) keyboard.push([{ text: localized(input.language, '✅ Подтвердить', '✅ Tasdiqlash', '✅ Confirm'), callback_data: 'v1:conf:0' }]);
      keyboard.push([{ text: localized(input.language, '✏️ Изменить', '✏️ Tahrirlash', '✏️ Edit'), callback_data: 'v1:edit:0' }]);
      const sent = await sendMessage(input.chatId,
        `${localized(input.language, '❓ Требуется уточнение', '❓ Aniqlashtirish kerak', '❓ Please clarify')}\n\n${escapeHtml(item.rawText)}`, {
        reply_markup: { inline_keyboard: keyboard },
      });
      await saveMessage({
        userId: input.uid, chatId: input.chatId, messageId: sent.message_id, kind: 'draft',
        items: [{ draftId: draft.id, transactionId: null }],
        options: { categoryIds, cardIds, page: 0 },
      });
      await updateDraft(draft.id, { botMessageId: sent.message_id, language: input.language });
    }
  }
  if (saved.length > 0) {
    const uniqueCardIds = [...new Set(saved.map((entry) => entry.cardId).filter(Boolean))] as string[];
    const cardDocuments = await Promise.all(uniqueCardIds.map((id) => db.collection('cards').doc(id).get()));
    const balanceLines = cardDocuments.filter((document) => document.exists).map((document) => {
      const card = document.data()!;
      const available = card.cardType === 'credit'
        ? Number(card.limit ?? 0) - Number(card.balance)
        : Number(card.balance);
      return `${escapeHtml(card.name)}: ${formatAmount(available, String(card.currency), input.language)}`;
    });
    const sent = await sendMessage(input.chatId,
      `${localized(
        input.language,
        saved.length > 1 ? `✅ Записал операций: ${saved.length}` : '✅ Записал',
        saved.length > 1 ? `✅ ${saved.length} ta operatsiya saqlandi` : '✅ Saqlandi',
        saved.length > 1 ? `✅ Saved ${saved.length} transactions` : '✅ Saved',
      )}\n\n${saved.slice(0, 5).map((entry) => entry.label).join('\n')}`
        + (saved.length > 5 ? `\n${localized(input.language, `… и ещё ${saved.length - 5}`, `… yana ${saved.length - 5} ta`, `… and ${saved.length - 5} more`)}` : '')
        + (balanceLines.length ? `\n\n${localized(input.language, 'Остаток:', 'Qoldiq:', 'Balance:')}\n${balanceLines.join('\n')}` : ''),
      {
        reply_markup: {
          inline_keyboard: [
            ...saved.slice(0, 5).map((_entry, index) => [{
              text: saved.length === 1 ? localized(input.language, '✏️ Изменить', '✏️ Tahrirlash', '✏️ Edit') : `✏️ ${index + 1}`,
              callback_data: `v1:edit:${index}`,
            }]),
            ...(saved.length > 5 ? [[{
              text: localized(input.language, '📱 Открыть историю', '📱 Tarixni ochish', '📱 Open history'), web_app: { url: `${env.WEB_APP_URL}?tab=transactions` },
            }]] : []),
          ],
        },
      },
    );
    await saveMessage({
      userId: input.uid, chatId: input.chatId, messageId: sent.message_id,
      kind: saved.length === 1 ? 'saved' : 'summary',
      items: saved.map((entry) => ({ draftId: null, transactionId: entry.transactionId })),
      options: {
        categoryIds: catalog.categories.map((category) => category.id),
        cardIds: catalog.cards.map((card) => card.id),
        page: 0,
      },
    });
  }
  if (invalidAmounts.length > 0) {
    const fragments = invalidAmounts.map((value) => `«${escapeHtml(value)}»`).join(', ');
    await sendMessage(input.chatId,
      input.language === 'uz'
        ? `Summani tushunmadim: ${fragments}.`
        : input.language === 'en' ? `I could not understand the amount: ${fragments}.` : `Не понял сумму: ${fragments}.`,
    );
  }
  logger.info({ uid: input.uid, updateId: input.updateId, saved: saved.length }, 'telegram.parse.completed');
}
