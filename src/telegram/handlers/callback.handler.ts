import { db } from '../../config/firebase';
import { env } from '../../config/env';
import { getIsPremium } from '../../services/entitlement.service';
import { createTelegramTransactionOnce, createTelegramTransferOnce, deleteTransaction, updateTransaction } from '../../services/transaction.service';
import { createTelegramDebtOnce, payTelegramDebtOnce } from '../../services/debt.service';
import { getRateToBase } from '../../services/fxRates.service';
import { answerCallbackQuery, editMessageText, sendMessage } from '../client';
import type { InlineKeyboardButton } from '../client';
import { resolveUserContext } from '../context';
import { getOwnedDraft, updateDraft } from '../drafts.repository';
import { getMessage, saveMessage } from '../messages.repository';
import { escapeHtml, languageKeyboard, loginKeyboard, premiumKeyboard, welcomeKeyboard } from '../render';
import { t } from '../i18n';
import type { DraftReason, ParsedOperationKind, SupportedLanguage } from '../types';
import { saveSession } from '../sessions.repository';
import { categoryDisplayName } from '../categoryAliases';
import type { Card, Category, Commission, Subcategory } from '../../domain/types';
import { mergeProfile } from '../../repositories/profile.repository';
import {
  formatDate, formatDraftOperation, formatSavedDebt, formatSavedDebtPayment, formatSavedTransaction, formatSavedTransfer, reasonText,
} from '../quickEntry.service';
import { handleNotificationAction, isNotificationAction } from './actions.handler';
import { logger } from '../../utils/logger';

const localized = (language: SupportedLanguage, ru: string, uz: string, en: string) =>
  language === 'uz' ? uz : language === 'en' ? en : ru;

const callbackPattern = /^v1:([a-z]+):(\d+)(?::([a-z0-9]+))?$/;
const hardReasons = new Set<DraftReason>([
  'AMBIGUOUS_SMALL_AMOUNT', 'AMOUNT_MISMATCH', 'NO_CATEGORY_MATCH',
  'NO_CARD_IN_CURRENCY', 'FX_UNAVAILABLE',
  'AMBIGUOUS_CARD_HINT', 'NO_SOURCE_CARD', 'NO_DESTINATION_CARD',
  'AMBIGUOUS_SOURCE_CARD', 'AMBIGUOUS_DESTINATION_CARD', 'TRANSFER_SAME_CARD', 'NO_TO_AMOUNT',
  'NO_DEBT_MATCH', 'AMBIGUOUS_DEBT', 'DEBT_ALREADY_PAID', 'DEBT_PAYMENT_TOO_LARGE', 'MISSING_PERSON',
  'AMBIGUOUS_DEBT_DIRECTION', 'DATE_IN_FUTURE',
]);

function without(reasons: DraftReason[], removed: DraftReason[]): DraftReason[] {
  const set = new Set(removed);
  return reasons.filter((reason) => !set.has(reason));
}

function draftKind(draft: FirebaseFirestore.DocumentData): ParsedOperationKind {
  const value = draft.operationType ?? (draft.draft as Record<string, unknown> | undefined)?.kind;
  return value === 'transfer' || value === 'debt' || value === 'debt_payment' ? value : 'transaction';
}

async function loadDraftCatalog(uid: string) {
  const [categories, subcategories, cards] = await Promise.all([
    db.collection('categories').where('userId', '==', uid).get(),
    db.collection('subcategories').where('userId', '==', uid).get(),
    db.collection('cards').where('userId', '==', uid).get(),
  ]);
  return {
    categories: categories.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Category),
    subcategories: subcategories.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Subcategory),
    cards: cards.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Card),
  };
}

async function refreshTransferDraft(
  draft: Record<string, unknown>,
  reasons: DraftReason[],
): Promise<DraftReason[]> {
  const fromId = String(draft.fromCardId ?? draft.cardId ?? '');
  const toId = String(draft.toCardId ?? '');
  const next = without(reasons, [
    'NO_SOURCE_CARD', 'NO_DESTINATION_CARD', 'AMBIGUOUS_SOURCE_CARD', 'AMBIGUOUS_DESTINATION_CARD',
    'TRANSFER_SAME_CARD', 'NO_TO_AMOUNT', 'FX_UNAVAILABLE',
  ]);
  if (!fromId) next.push('NO_SOURCE_CARD');
  if (!toId) next.push('NO_DESTINATION_CARD');
  if (!fromId || !toId) return [...new Set(next)];

  const [fromSnap, toSnap] = await Promise.all([
    db.collection('cards').doc(fromId).get(),
    db.collection('cards').doc(toId).get(),
  ]);
  if (!fromSnap.exists || !toSnap.exists) {
    next.push('NO_SOURCE_CARD');
    return [...new Set(next)];
  }
  const from = fromSnap.data()!;
  const to = toSnap.data()!;
  draft.currency = from.currency;
  draft.toCurrency = to.currency;
  if (fromId === toId) {
    next.push('TRANSFER_SAME_CARD');
    return [...new Set(next)];
  }
  const amount = Number(draft.amount);
  if (from.currency === to.currency) {
    draft.toAmount = amount;
    return [...new Set(next)];
  }
  const existingReceived = Number(draft.toAmount);
  if (!Number.isFinite(existingReceived) || existingReceived <= 0) {
    const date = Number(draft.date) || Date.now();
    const [fromRate, toRate] = await Promise.all([
      getRateToBase(from.currency, date),
      getRateToBase(to.currency, date),
    ]);
    if (fromRate && toRate && Number.isFinite(amount) && amount > 0) {
      draft.toAmount = Number((amount * fromRate / toRate).toFixed(to.currency === 'UZS' ? 0 : 2));
    } else {
      next.push('NO_TO_AMOUNT');
    }
    if (from.currency !== 'UZS') {
      if (fromRate) Object.assign(draft, {
        baseAmount: Math.round(amount * fromRate), fxRate: fromRate, fxRateSource: 'NBU',
      });
      else next.push('FX_UNAVAILABLE');
    }
  }
  if (Number(draft.toAmount) <= 0) next.push('NO_TO_AMOUNT');
  return [...new Set(next)];
}

async function remainingKeyboard(
  reasons: DraftReason[],
  draft: FirebaseFirestore.DocumentData,
  message: NonNullable<Awaited<ReturnType<typeof getMessage>>>,
  language: SupportedLanguage,
) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const operationType = draftKind(draft);
  const transaction = draft.draft as Record<string, unknown>;
  if (reasons.includes('AMBIGUOUS_SMALL_AMOUNT') || reasons.includes('AMOUNT_MISMATCH')) {
    rows.push([
      { text: String(transaction.amount), callback_data: 'v1:amt:0:0' },
      { text: String(draft.amountAlternative), callback_data: 'v1:amt:0:1' },
    ]);
  }
  if (reasons.includes('NO_CATEGORY_MATCH')) {
    const ids = message.options?.categoryIds ?? [];
    const docs = await Promise.all(ids.slice(0, 6).map((id) => db.collection('categories').doc(id).get()));
    docs.forEach((document, index) => {
      if (document.exists) rows.push([{
        text: `${document.data()!.icon ?? ''} ${categoryDisplayName(document.data() as Category, language)}`,
        callback_data: `v1:cat:0:${index}`,
      }]);
    });
    if (draft.suggestion?.categoryName) rows.push([{
      text: `➕ ${draft.suggestion.categoryName}`,
      callback_data: 'v1:newcat:0',
    }]);
  }
  if (operationType === 'transaction' && (reasons.includes('NO_CARD_IN_CURRENCY') || reasons.includes('INSUFFICIENT_FUNDS') || reasons.includes('AMBIGUOUS_CARD_HINT'))) {
    const ids = message.options?.cardIds ?? [];
    const docs = await Promise.all(ids.slice(0, 6).map((id) => db.collection('cards').doc(id).get()));
    docs.forEach((document, index) => {
      if (document.exists) rows.push([{
        text: `💳 ${document.data()!.name}`,
        callback_data: `v1:card:0:${index}`,
      }]);
    });
  }
  if (operationType === 'transfer' && (reasons.includes('NO_SOURCE_CARD') || reasons.includes('AMBIGUOUS_SOURCE_CARD'))) {
    const ids = message.options?.cardIds ?? [];
    const docs = await Promise.all(ids.slice(0, 6).map((id) => db.collection('cards').doc(id).get()));
    docs.forEach((document, index) => {
      if (document.exists) rows.push([{ text: `📤 ${document.data()!.name}`, callback_data: `v1:from:0:${index}` }]);
    });
  }
  if (operationType === 'transfer' && (reasons.includes('NO_DESTINATION_CARD') || reasons.includes('AMBIGUOUS_DESTINATION_CARD'))) {
    const ids = message.options?.cardIds ?? [];
    const docs = await Promise.all(ids.slice(0, 6).map((id) => db.collection('cards').doc(id).get()));
    docs.forEach((document, index) => {
      if (document.exists) rows.push([{ text: `📥 ${document.data()!.name}`, callback_data: `v1:to:0:${index}` }]);
    });
  }
  if (['debt', 'debt_payment'].includes(operationType)
    && (reasons.includes('NO_SOURCE_CARD') || reasons.includes('AMBIGUOUS_SOURCE_CARD'))) {
    const ids = message.options?.cardIds ?? [];
    const docs = await Promise.all(ids.slice(0, 6).map((id) => db.collection('cards').doc(id).get()));
    docs.forEach((document, index) => {
      if (document.exists) rows.push([{ text: `💳 ${document.data()!.name}`, callback_data: `v1:card:0:${index}` }]);
    });
  }
  if (operationType === 'transfer' && reasons.includes('NO_TO_AMOUNT')) {
    rows.push([{ text: localized(language, '💰 Указать сумму зачисления', '💰 Tushgan summani ko‘rsatish', '💰 Enter received amount'), callback_data: 'v1:field:0:toamt' }]);
  }
  if (reasons.includes('DATE_IN_FUTURE')) {
    rows.push([{ text: localized(language, '📅 Указать дату', '📅 Sanani ko‘rsatish', '📅 Enter date'), callback_data: 'v1:field:0:dat' }]);
  }
  if (!reasons.some((reason) => hardReasons.has(reason))) {
    rows.push([{ text: localized(language, '✅ Подтвердить', '✅ Tasdiqlash', '✅ Confirm'), callback_data: 'v1:conf:0' }]);
  }
  return { inline_keyboard: rows };
}

async function confirm(
  uid: string,
  chatId: string,
  messageId: number,
  draft: FirebaseFirestore.DocumentData,
  language: SupportedLanguage,
): Promise<string> {
  const reasons = (draft.reasons ?? []) as DraftReason[];
  if (reasons.some((reason) => hardReasons.has(reason))) return localized(language, 'Сначала заполните обязательные поля', 'Avval majburiy maydonlarni to‘ldiring', 'Complete the required fields first');
  const operation = draft.draft as Record<string, unknown>;
  const kind = draftKind(draft);
  const operationKey = String(draft.operationKey);
  const catalog = await loadDraftCatalog(uid);
  let transactionId: string | undefined;
  let resultText: string;

  if (kind === 'transaction') {
    if (!operation.categoryId) return localized(language, 'Сначала выберите категорию', 'Avval toifani tanlang', 'Choose a category first');
    const result = await createTelegramTransactionOnce(uid, operation, operationKey, String(draft.id));
    transactionId = String(result.transaction.id);
    resultText = formatSavedTransaction(result.transaction, catalog, language);
  } else if (kind === 'transfer') {
    const fromCardId = String(operation.fromCardId ?? operation.cardId ?? '');
    const toCardId = String(operation.toCardId ?? '');
    if (!fromCardId || !toCardId) return localized(language, 'Сначала выберите обе карты перевода', 'Avval o‘tkazmaning ikkala kartasini tanlang', 'Choose both transfer cards first');
    const result = await createTelegramTransferOnce(uid, {
      fromCardId,
      toCardId,
      amount: Number(operation.amount),
      toAmount: Number(operation.toAmount) > 0 ? Number(operation.toAmount) : undefined,
      baseAmount: Number(operation.baseAmount) > 0 ? Number(operation.baseAmount) : undefined,
      fxRate: Number(operation.fxRate) > 0 ? Number(operation.fxRate) : undefined,
      fxRateSource: operation.fxRateSource === 'NBU' || operation.fxRateSource === 'manual' ? operation.fxRateSource : undefined,
      date: Number(operation.date) || Date.now(),
      comment: String(operation.comment ?? ''),
    }, operationKey);
    transactionId = String(result.transaction.id);
    resultText = formatSavedTransfer(result.transaction, catalog, language);
  } else if (kind === 'debt') {
    const result = await createTelegramDebtOnce(uid, {
      direction: operation.direction as 'i_owe' | 'owe_me',
      person: String(operation.person ?? ''),
      amount: Number(operation.amount),
      currency: String(operation.currency),
      commission: operation.commission as Commission | undefined,
      dueDate: Number(operation.dueDate) > 0 ? Number(operation.dueDate) : undefined,
      comment: String(operation.comment ?? ''),
      accountId: operation.accountId ? String(operation.accountId) : undefined,
      date: Number(operation.date) || Date.now(),
    }, operationKey);
    resultText = formatSavedDebt(result.debt, catalog, language);
  } else {
    const accountId = operation.accountId ? String(operation.accountId) : undefined;
    const result = await payTelegramDebtOnce(uid, {
      debtId: String(operation.debtId),
      amount: Number(operation.amount),
      accountId,
      date: Number(operation.date) || Date.now(),
      comment: String(operation.comment ?? ''),
    }, operationKey);
    transactionId = result.transactionId;
    resultText = formatSavedDebtPayment({ ...result, accountId }, catalog, language);
  }

  await updateDraft(String(draft.id), {
    status: 'confirmed',
    ...(transactionId ? { transactionId } : {}),
  });
  const softReasons = [...new Set(reasons.filter((reason) => !hardReasons.has(reason)))];
  if (softReasons.length) {
    resultText = `${localized(language, '⚠️ Сохранено, но обратите внимание', '⚠️ Saqlandi, lekin e’tibor bering', '⚠️ Saved, but please note')}\n\n${resultText}\n\n${softReasons.map((reason) => `• ${reasonText(reason, language)}`).join('\n')}`;
  }
  const buttons: InlineKeyboardButton[][] = [[{
    text: localized(language, '📱 Открыть в приложении', '📱 Ilovada ochish', '📱 Open in app'),
    web_app: { url: kind === 'transaction' && transactionId
      ? `${env.WEB_APP_URL}?tx=${transactionId}`
      : `${env.WEB_APP_URL}?tab=${kind === 'debt' || kind === 'debt_payment' ? 'debts' : 'transactions'}` },
  }]];
  if (kind === 'transaction' && transactionId) {
    buttons.push([{ text: localized(language, '✏️ Изменить', '✏️ Tahrirlash', '✏️ Edit'), callback_data: 'v1:edit:0' }]);
  }
  await editMessageText(chatId, messageId, resultText, { reply_markup: { inline_keyboard: buttons } });
  await saveMessage({
    userId: uid,
    chatId,
    messageId,
    kind: 'saved',
    items: [{ draftId: null, transactionId: kind === 'transaction' ? transactionId ?? null : null }],
    options: {
      categoryIds: catalog.categories.map((category) => category.id),
      cardIds: catalog.cards.map((card) => card.id),
      page: 0,
    },
  });
  return localized(language, 'Сохранено', 'Saqlandi', 'Saved');
}

async function ownedTransaction(uid: string, transactionId: string) {
  const snap = await db.collection('transactions').doc(transactionId).get();
  if (!snap.exists || snap.data()!.userId !== uid) return null;
  return { id: snap.id, ...snap.data() } as Record<string, unknown>;
}

async function renderTransaction(chatId: string, messageId: number, transaction: Record<string, unknown>, edit: boolean, language: SupportedLanguage, itemIndex = 0) {
  const category = transaction.categoryId
    ? await db.collection('categories').doc(String(transaction.categoryId)).get() : null;
  const card = transaction.cardId
    ? await db.collection('cards').doc(String(transaction.cardId)).get() : null;
  const categoryName = category?.exists ? categoryDisplayName(category.data() as Category, language) : '';
  const cardName = card?.exists
    ? String(card.data()?.name ?? '')
    : localized(language, 'карта не указана · баланс не изменён', 'karta ko‘rsatilmagan · balans o‘zgarmadi', 'card not specified · balance unchanged');
  const text = `${edit ? localized(language, '✏️ Редактирование', '✏️ Tahrirlash', '✏️ Editing') : localized(language, '✅ Записано', '✅ Saqlandi', '✅ Saved')}\n\n`
    + `${escapeHtml(category?.data()?.icon ?? '')} ${escapeHtml(categoryName)} · ${escapeHtml(transaction.comment ?? '')}\n`
    + `${escapeHtml(transaction.amount)} ${escapeHtml(transaction.currency)} · 💳 ${escapeHtml(cardName)}\n`
    + `📅 ${escapeHtml(formatDate(transaction.date, language))}`;
  const keyboard = edit ? [
    [{ text: localized(language, '🏷 Категория', '🏷 Toifa', '🏷 Category'), callback_data: `v1:txcats:${itemIndex}` }, { text: localized(language, '💳 Карта', '💳 Karta', '💳 Card'), callback_data: `v1:txcards:${itemIndex}` }],
    [{ text: localized(language, '💰 Сумма', '💰 Summa', '💰 Amount'), callback_data: `v1:field:${itemIndex}:amt` }, { text: localized(language, '💬 Комментарий', '💬 Izoh', '💬 Comment'), callback_data: `v1:field:${itemIndex}:com` }],
    [{ text: localized(language, '📅 Дата', '📅 Sana', '📅 Date'), callback_data: `v1:field:${itemIndex}:dat` }],
    [{ text: localized(language, '🗑 Удалить', '🗑 O‘chirish', '🗑 Delete'), callback_data: `v1:del:${itemIndex}` }],
    [{ text: localized(language, '🌐 Открыть в приложении', '🌐 Ilovada ochish', '🌐 Open in app'), web_app: { url: `${env.WEB_APP_URL}?tx=${transaction.id}` } }],
    [{ text: localized(language, '⬅️ Готово', '⬅️ Tayyor', '⬅️ Done'), callback_data: `v1:back:${itemIndex}` }],
  ] : [[{ text: localized(language, '✏️ Изменить', '✏️ Tahrirlash', '✏️ Edit'), callback_data: `v1:edit:${itemIndex}` }]];
  await editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
}

export async function handleCallbackQuery(input: {
  id: string;
  data: string;
  chatId: string;
  messageId: number;
  telegramId: string;
}): Promise<string | null> {
  let answer = '';
  let responseLanguage: SupportedLanguage = 'uz';
  try {
    const parsed = callbackPattern.exec(input.data);
    if (!parsed) {
      answer = 'Команда устарела';
      return null;
    }
    const [, action, itemRaw, optionRaw] = parsed;
    const context = await resolveUserContext(input.telegramId, input.chatId);
    if (action === 'startlang') {
      if (optionRaw !== 'uz' && optionRaw !== 'ru' && optionRaw !== 'en') {
        answer = 'Недоступно';
        return context?.uid ?? null;
      }
      responseLanguage = optionRaw;
      if (context) {
        await mergeProfile(context.uid, { language: optionRaw });
        await editMessageText(input.chatId, input.messageId, t(optionRaw, 'welcome'), {
          reply_markup: welcomeKeyboard(optionRaw),
        });
        answer = '';
        return context.uid;
      }
      await editMessageText(input.chatId, input.messageId, t(optionRaw, 'welcome_unlinked'), {
        reply_markup: loginKeyboard(optionRaw),
      });
      answer = '';
      return null;
    }
    if (!context) {
      answer = 'Недоступно';
      return null;
    }
    responseLanguage = context.language;
    if (action === 'langmenu') {
      await editMessageText(input.chatId, input.messageId, t(context.language, 'language_prompt'), {
        reply_markup: languageKeyboard(),
      });
      answer = '';
      return context.uid;
    }
    if (action === 'lang') {
      if (optionRaw !== 'uz' && optionRaw !== 'ru' && optionRaw !== 'en') {
        answer = 'Недоступно';
        return context.uid;
      }
      await mergeProfile(context.uid, { language: optionRaw });
      await editMessageText(input.chatId, input.messageId, t(optionRaw, 'language_changed'), {
        reply_markup: languageKeyboard(),
      });
      responseLanguage = optionRaw;
      answer = '';
      return context.uid;
    }
    const message = await getMessage(input.chatId, input.messageId);
    if (!message || message.userId !== context.uid) {
      answer = 'Недоступно';
      return null;
    }
    if (isNotificationAction(action)) {
      answer = await handleNotificationAction({
        action,
        itemIndex: Number(itemRaw),
        optionIndex: optionRaw === undefined ? undefined : Number(optionRaw),
        chatId: input.chatId,
        messageId: input.messageId,
        context,
        message,
      });
      logger.info({ uid: context.uid, action, result: answer || 'updated' }, 'notify.action');
      return context.uid;
    }
    const isPremium = await getIsPremium(context.uid);
    const itemIndex = Number(itemRaw);
    const item = message.items[itemIndex];
    if (item?.transactionId) {
      const transaction = await ownedTransaction(context.uid, item.transactionId);
      if (!transaction) {
        answer = 'Операция не найдена';
        return context.uid;
      }
      if (action === 'edit' || action === 'back') {
        await renderTransaction(input.chatId, input.messageId, transaction, action === 'edit', context.language, itemIndex);
        answer = '';
        return context.uid;
      }
      if (action === 'field' && optionRaw && ['amt', 'com', 'dat'].includes(optionRaw)) {
        const prompt = await sendMessage(input.chatId,
          optionRaw === 'amt'
            ? localized(context.language, 'Введите новую сумму', 'Yangi summani kiriting', 'Enter the new amount')
            : optionRaw === 'com'
              ? localized(context.language, 'Введите комментарий', 'Izohni kiriting', 'Enter a comment')
              : localized(context.language, 'Введите дату', 'Sanani kiriting', 'Enter the date'),
          { reply_markup: { force_reply: true } },
        );
        await saveSession(input.chatId, {
          userId: context.uid,
          field: optionRaw === 'amt' ? 'amount' : optionRaw === 'com' ? 'comment' : 'date',
          draftId: null,
          transactionId: item.transactionId,
          contextMessageId: input.messageId,
          promptMessageId: prompt.message_id,
          itemIndex,
        });
        answer = 'Жду ответ';
        return context.uid;
      }
      if (action === 'del') {
        await editMessageText(input.chatId, input.messageId,
          localized(context.language, 'Удалить эту операцию?', 'Bu operatsiya o‘chirilsinmi?', 'Delete this transaction?'), {
          reply_markup: { inline_keyboard: [[
            { text: localized(context.language, 'Да, удалить', 'Ha, o‘chirish', 'Yes, delete'), callback_data: `v1:delok:${itemIndex}` },
            { text: localized(context.language, 'Отмена', 'Bekor qilish', 'Cancel'), callback_data: `v1:edit:${itemIndex}` },
          ]] },
        });
        answer = '';
        return context.uid;
      }
      if (action === 'delok') {
        await deleteTransaction(context.uid, item.transactionId);
        await editMessageText(input.chatId, input.messageId, '🗑 Операция удалена');
        answer = 'Удалено';
        return context.uid;
      }
      if (['txcats', 'txcards', 'txcatp', 'txcardp'].includes(action)) {
        const isCategory = action === 'txcats' || action === 'txcatp';
        const ids = isCategory ? message.options?.categoryIds ?? [] : message.options?.cardIds ?? [];
        const collection = isCategory ? 'categories' : 'cards';
        const page = action.endsWith('p') ? Math.max(0, Number(optionRaw ?? 0)) : 0;
        const pageSize = 6;
        const start = page * pageSize;
        const pageIds = ids.slice(start, start + pageSize);
        const docs = await Promise.all(pageIds.map((id) => db.collection(collection).doc(id).get()));
        const rows = docs.flatMap((doc, offset) => doc.exists ? [[{
          text: isCategory
            ? `${doc.data()!.icon ?? ''} ${categoryDisplayName(doc.data() as Category, context.language)}`
            : `💳 ${doc.data()!.name}`,
          callback_data: `v1:${isCategory ? 'cat' : 'card'}:${itemIndex}:${start + offset}`,
        }]] : []);
        const navigation = [];
        if (page > 0) navigation.push({ text: '⬆️ Назад', callback_data: `v1:${isCategory ? 'txcatp' : 'txcardp'}:${itemIndex}:${page - 1}` });
        if (start + pageSize < ids.length) navigation.push({ text: '⬇️ Ещё', callback_data: `v1:${isCategory ? 'txcatp' : 'txcardp'}:${itemIndex}:${page + 1}` });
        if (navigation.length) rows.push(navigation);
        rows.push([{ text: '⬅️ К редактированию', callback_data: `v1:edit:${itemIndex}` }]);
        await editMessageText(input.chatId, input.messageId, isCategory ? 'Выберите категорию' : 'Выберите карту', {
          reply_markup: { inline_keyboard: rows },
        });
        answer = '';
        return context.uid;
      }
      if (action === 'cat' || action === 'card') {
        const id = action === 'cat'
          ? message.options?.categoryIds[Number(optionRaw)]
          : message.options?.cardIds[Number(optionRaw)];
        if (!id) {
          answer = 'Вариант недоступен';
          return context.uid;
        }
        await updateTransaction(context.uid, item.transactionId,
          action === 'cat' ? { categoryId: id } : { cardId: id });
        const updated = await ownedTransaction(context.uid, item.transactionId);
        if (updated) await renderTransaction(input.chatId, input.messageId, updated, true, context.language, itemIndex);
        answer = 'Обновлено';
        return context.uid;
      }
    }
    if (!item?.draftId) {
      answer = 'Запись устарела';
      return context.uid;
    }
    const draft = await getOwnedDraft(item.draftId, context.uid);
    if (!draft || Number(draft.expiresAtMs ?? 0) <= Date.now()) {
      if (draft) await updateDraft(item.draftId, { status: 'expired' });
      await editMessageText(input.chatId, input.messageId, '⌛ Эта запись устарела.').catch(() => undefined);
      answer = 'Эта запись устарела';
      return context.uid;
    }
    if (draft.status === 'confirmed') {
      answer = 'Уже записано';
      return context.uid;
    }
    if (draft.status !== 'pending') {
      answer = 'Запись недоступна';
      return context.uid;
    }

    const transaction = { ...(draft.draft as Record<string, unknown>) };
    let reasons = [...(draft.reasons as DraftReason[])];
    if (['txcats', 'txcards', 'txcatp', 'txcardp'].includes(action)) {
      const isCategory = action === 'txcats' || action === 'txcatp';
      const ids = isCategory ? message.options?.categoryIds ?? [] : message.options?.cardIds ?? [];
      const collection = isCategory ? 'categories' : 'cards';
      const page = action.endsWith('p') ? Math.max(0, Number(optionRaw ?? 0)) : 0;
      const start = page * 6;
      const docs = await Promise.all(ids.slice(start, start + 6).map((id) => db.collection(collection).doc(id).get()));
      const rows = docs.flatMap((doc, offset) => doc.exists ? [[{
        text: isCategory
          ? `${doc.data()!.icon ?? ''} ${categoryDisplayName(doc.data() as Category, context.language)}`
          : `💳 ${doc.data()!.name}`,
        callback_data: `v1:${isCategory ? 'cat' : 'card'}:0:${start + offset}`,
      }]] : []);
      const navigation = [];
      if (page > 0) navigation.push({ text: '⬆️ Назад', callback_data: `v1:${isCategory ? 'txcatp' : 'txcardp'}:0:${page - 1}` });
      if (start + 6 < ids.length) navigation.push({ text: '⬇️ Ещё', callback_data: `v1:${isCategory ? 'txcatp' : 'txcardp'}:0:${page + 1}` });
      if (navigation.length) rows.push(navigation);
      rows.push([{ text: '⬅️ К редактированию', callback_data: 'v1:edit:0' }]);
      await editMessageText(input.chatId, input.messageId, isCategory ? 'Выберите категорию' : 'Выберите карту', {
        reply_markup: { inline_keyboard: rows },
      });
      answer = '';
      return context.uid;
    } else if (action === 'edit') {
      const catalog = await loadDraftCatalog(context.uid);
      const keyboard = await remainingKeyboard(reasons, draft, message, context.language);
      keyboard.inline_keyboard.push([{ text: localized(context.language, '🗑 Удалить', '🗑 O‘chirish', '🗑 Delete'), callback_data: 'v1:del:0' }]);
      await editMessageText(input.chatId, input.messageId,
        formatDraftOperation(draftKind(draft), transaction, catalog, context.language, reasons),
        { reply_markup: keyboard },
      );
      answer = '';
      return context.uid;
    } else if (action === 'field' && optionRaw && ['amt', 'com', 'dat', 'toamt'].includes(optionRaw)) {
      const prompt = await sendMessage(input.chatId,
        optionRaw === 'amt'
          ? localized(context.language, 'Введите новую сумму', 'Yangi summani kiriting', 'Enter the new amount')
          : optionRaw === 'toamt'
            ? localized(context.language, 'Введите сумму, которая зачислится на карту назначения', 'Qabul qiluvchi kartaga tushadigan summani kiriting', 'Enter the amount received on the destination card')
          : optionRaw === 'com'
            ? localized(context.language, 'Введите комментарий', 'Izohni kiriting', 'Enter a comment')
            : localized(context.language, 'Введите дату', 'Sanani kiriting', 'Enter the date'),
        { reply_markup: { force_reply: true } },
      );
      await saveSession(input.chatId, {
        userId: context.uid,
        field: optionRaw === 'amt' ? 'amount' : optionRaw === 'toamt' ? 'toAmount' : optionRaw === 'com' ? 'comment' : 'date',
        draftId: item.draftId,
        transactionId: null,
        contextMessageId: input.messageId,
        promptMessageId: prompt.message_id,
        itemIndex,
      });
      answer = 'Жду ответ';
      return context.uid;
    } else if (action === 'del') {
      await editMessageText(input.chatId, input.messageId, 'Удалить этот черновик?', {
        reply_markup: { inline_keyboard: [[
          { text: 'Да, удалить', callback_data: 'v1:delok:0' },
          { text: 'Отмена', callback_data: 'v1:edit:0' },
        ]] },
      });
      answer = '';
      return context.uid;
    } else if (action === 'delok') {
      await updateDraft(item.draftId, { status: 'cancelled' });
      await editMessageText(input.chatId, input.messageId, '🗑 Черновик удалён');
      answer = 'Удалено';
      return context.uid;
    } else if (action === 'back') {
      const keyboard = await remainingKeyboard(reasons, draft, message, context.language);
      const catalog = await loadDraftCatalog(context.uid);
      await editMessageText(input.chatId, input.messageId,
        formatDraftOperation(draftKind(draft), transaction, catalog, context.language, reasons),
        { reply_markup: keyboard },
      );
      answer = '';
      return context.uid;
    } else if (action === 'amt') {
      const option = Number(optionRaw);
      const amount = option === 1 ? Number(draft.amountAlternative) : Number(transaction.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        answer = 'Неверная сумма';
        return context.uid;
      }
      transaction.amount = amount;
      if (transaction.currency !== 'UZS' && Number(transaction.fxRate) > 0) {
        transaction.baseAmount = Math.round(amount * Number(transaction.fxRate));
      }
      reasons = without(reasons, ['AMBIGUOUS_SMALL_AMOUNT', 'AMOUNT_MISMATCH', 'LOW_AMOUNT_CONFIDENCE']);
      if (draftKind(draft) === 'transfer') reasons = await refreshTransferDraft(transaction, reasons);
    } else if (action === 'cat') {
      const categoryId = message.options?.categoryIds[Number(optionRaw)];
      if (!categoryId) {
        answer = 'Категория недоступна';
        return context.uid;
      }
      const category = await db.collection('categories').doc(categoryId).get();
      if (!category.exists || category.data()!.userId !== context.uid) {
        answer = 'Категория недоступна';
        return context.uid;
      }
      transaction.categoryId = categoryId;
      delete transaction.subcategoryId;
      reasons = without(reasons, ['NO_CATEGORY_MATCH', 'LOW_CATEGORY_CONFIDENCE']);
    } else if (action === 'newcat') {
      if (!isPremium) {
        const text = t(context.language, 'premium_category_required');
        await sendMessage(input.chatId, text, { reply_markup: premiumKeyboard(context.language) });
        answer = text;
        return context.uid;
      }
      const suggestion = draft.suggestion as { categoryName?: string; categoryIcon?: string } | null;
      if (!suggestion?.categoryName) {
        answer = 'Нет предложенной категории';
        return context.uid;
      }
      const categoryRef = db.collection('categories').doc();
      await categoryRef.create({
        userId: context.uid,
        name: suggestion.categoryName.slice(0, 40),
        icon: suggestion.categoryIcon?.slice(0, 8) || '📦',
        color: '#636366',
        type: transaction.type,
        createdAt: Date.now(),
      });
      transaction.categoryId = categoryRef.id;
      reasons = without(reasons, ['NO_CATEGORY_MATCH', 'LOW_CATEGORY_CONFIDENCE']);
    } else if (action === 'from' || action === 'to') {
      const cardId = message.options?.cardIds[Number(optionRaw)];
      if (!cardId) {
        answer = 'Карта недоступна';
        return context.uid;
      }
      const card = await db.collection('cards').doc(cardId).get();
      if (!card.exists || card.data()!.userId !== context.uid) {
        answer = 'Карта недоступна';
        return context.uid;
      }
      if (action === 'from') {
        transaction.cardId = cardId;
        transaction.fromCardId = cardId;
      } else {
        transaction.toCardId = cardId;
      }
      reasons = draftKind(draft) === 'transfer'
        ? await refreshTransferDraft(transaction, reasons)
        : without(reasons, ['NO_SOURCE_CARD', 'AMBIGUOUS_SOURCE_CARD']);
    } else if (action === 'card') {
      const cardId = message.options?.cardIds[Number(optionRaw)];
      if (!cardId) {
        answer = 'Карта недоступна';
        return context.uid;
      }
      const card = await db.collection('cards').doc(cardId).get();
      if (!card.exists || card.data()!.userId !== context.uid) {
        answer = 'Карта недоступна';
        return context.uid;
      }
      if (draftKind(draft) === 'debt' || draftKind(draft) === 'debt_payment') {
        transaction.accountId = cardId;
        reasons = without(reasons, ['NO_SOURCE_CARD', 'AMBIGUOUS_SOURCE_CARD', 'NO_CARDS']);
      } else {
        transaction.cardId = cardId;
        reasons = without(reasons, ['INSUFFICIENT_FUNDS', 'NO_CARD_IN_CURRENCY', 'AMBIGUOUS_CARD_HINT', 'NO_CARDS']);
      }
    } else if (action === 'conf') {
      if (!isPremium && draftKind(draft) === 'debt') {
        const text = t(context.language, 'premium_debt_required');
        await sendMessage(input.chatId, text, { reply_markup: premiumKeyboard(context.language) });
        answer = text;
        return context.uid;
      }
      answer = await confirm(context.uid, input.chatId, input.messageId, draft, context.language);
      return context.uid;
    } else {
      answer = 'Команда пока недоступна';
      return context.uid;
    }

    const waitingFx = reasons.length === 1 && reasons[0] === 'FX_UNAVAILABLE';
    await updateDraft(item.draftId, {
      draft: transaction,
      reasons,
      ...(waitingFx ? { status: 'waiting_fx', nextAttemptAt: Date.now() } : {}),
    });
    if (waitingFx) {
      await editMessageText(input.chatId, input.messageId,
        '⏳ Жду курс ЦБ. Операция сохранится автоматически.',
      );
      answer = 'Поставлено в очередь';
      return context.uid;
    }
    const updated = { ...draft, draft: transaction, reasons };
    if (reasons.length === 0) {
      if (!isPremium && draftKind(updated) === 'debt') {
        const text = t(context.language, 'premium_debt_required');
        await sendMessage(input.chatId, text, { reply_markup: premiumKeyboard(context.language) });
        answer = text;
        return context.uid;
      }
      answer = await confirm(context.uid, input.chatId, input.messageId, updated, context.language);
    } else {
      const keyboard = await remainingKeyboard(reasons, updated, message, context.language);
      const catalog = await loadDraftCatalog(context.uid);
      await editMessageText(input.chatId, input.messageId,
        formatDraftOperation(draftKind(updated), transaction, catalog, context.language, reasons),
        { reply_markup: keyboard },
      );
      answer = 'Обновлено';
    }
    return context.uid;
  } catch {
    await sendMessage(input.chatId,
      localized(responseLanguage, '⚠️ Не удалось завершить сохранение. Попробуйте ещё раз — я проверю запись и не создам дубль.', '⚠️ Saqlashni yakunlab bo‘lmadi. Qayta urinib ko‘ring — yozuvni tekshiraman va dublikat yaratmayman.', '⚠️ I could not complete the save. Please try again — I will check the entry and avoid creating a duplicate.'),
    ).catch(() => undefined);
    return null;
  } finally {
    await answerCallbackQuery(input.id, answer || undefined).catch(() => undefined);
  }
}
