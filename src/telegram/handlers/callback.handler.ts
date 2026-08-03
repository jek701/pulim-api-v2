import { db } from '../../config/firebase';
import { env } from '../../config/env';
import { getIsPremium } from '../../services/entitlement.service';
import { createTelegramTransactionOnce, deleteTransaction, updateTransaction } from '../../services/transaction.service';
import { answerCallbackQuery, editMessageText, sendMessage } from '../client';
import { resolveUserContext } from '../context';
import { getOwnedDraft, updateDraft } from '../drafts.repository';
import { getMessage } from '../messages.repository';
import { escapeHtml } from '../render';
import type { DraftReason, SupportedLanguage } from '../types';
import { saveSession } from '../sessions.repository';
import { categoryDisplayName } from '../categoryAliases';
import type { Category } from '../../domain/types';

const localized = (language: SupportedLanguage, ru: string, uz: string, en: string) =>
  language === 'uz' ? uz : language === 'en' ? en : ru;

const callbackPattern = /^v1:([a-z]+):(\d+)(?::([a-z0-9]+))?$/;
const hardReasons = new Set<DraftReason>([
  'AMBIGUOUS_SMALL_AMOUNT', 'AMOUNT_MISMATCH', 'NO_CATEGORY_MATCH',
  'NO_CARD_IN_CURRENCY', 'FX_UNAVAILABLE',
  'AMBIGUOUS_CARD_HINT',
]);

function without(reasons: DraftReason[], removed: DraftReason[]): DraftReason[] {
  const set = new Set(removed);
  return reasons.filter((reason) => !set.has(reason));
}

async function remainingKeyboard(
  reasons: DraftReason[],
  draft: FirebaseFirestore.DocumentData,
  message: NonNullable<Awaited<ReturnType<typeof getMessage>>>,
  language: SupportedLanguage,
) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (reasons.includes('AMBIGUOUS_SMALL_AMOUNT') || reasons.includes('AMOUNT_MISMATCH')) {
    const transaction = draft.draft as Record<string, unknown>;
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
  if (reasons.includes('NO_CARD_IN_CURRENCY') || reasons.includes('INSUFFICIENT_FUNDS') || reasons.includes('AMBIGUOUS_CARD_HINT')) {
    const ids = message.options?.cardIds ?? [];
    const docs = await Promise.all(ids.slice(0, 6).map((id) => db.collection('cards').doc(id).get()));
    docs.forEach((document, index) => {
      if (document.exists) rows.push([{
        text: `💳 ${document.data()!.name}`,
        callback_data: `v1:card:0:${index}`,
      }]);
    });
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
  const transaction = draft.draft as Record<string, unknown>;
  if (!transaction.categoryId) return localized(language, 'Сначала выберите категорию', 'Avval toifani tanlang', 'Choose a category first');
  const result = await createTelegramTransactionOnce(uid, transaction, String(draft.operationKey), String(draft.id));
  await editMessageText(chatId, messageId,
    `${localized(language, '✅ Записал', '✅ Saqlandi', '✅ Saved')}\n\n${escapeHtml(transaction.comment || localized(language, 'Операция', 'Operatsiya', 'Transaction'))} — ${escapeHtml(transaction.amount)} ${escapeHtml(transaction.currency)}`,
  );
  return result.created
    ? localized(language, 'Записано', 'Saqlandi', 'Saved')
    : localized(language, 'Уже записано', 'Allaqachon saqlangan', 'Already saved');
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
  const text = `${edit ? localized(language, '✏️ Редактирование', '✏️ Tahrirlash', '✏️ Editing') : localized(language, '✅ Записано', '✅ Saqlandi', '✅ Saved')}\n\n`
    + `${escapeHtml(category?.data()?.icon ?? '')} ${escapeHtml(categoryName)} · ${escapeHtml(transaction.comment ?? '')}\n`
    + `${escapeHtml(transaction.amount)} ${escapeHtml(transaction.currency)} · 💳 ${escapeHtml(card?.data()?.name ?? 'Без карты')}`;
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
  try {
    const parsed = callbackPattern.exec(input.data);
    if (!parsed) {
      answer = 'Команда устарела';
      return null;
    }
    const [, action, itemRaw, optionRaw] = parsed;
    const message = await getMessage(input.chatId, input.messageId);
    const context = await resolveUserContext(input.telegramId, input.chatId);
    if (!message || !context || message.userId !== context.uid) {
      answer = 'Недоступно';
      return null;
    }
    if (!(await getIsPremium(context.uid))) {
      answer = 'Требуется Premium';
      return context.uid;
    }
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
      await editMessageText(input.chatId, input.messageId,
        `${localized(context.language, '✏️ Редактирование', '✏️ Tahrirlash', '✏️ Editing')}\n\n${escapeHtml(transaction.comment ?? draft.sourceText)} — ${escapeHtml(transaction.amount)} ${escapeHtml(transaction.currency)}`,
        { reply_markup: { inline_keyboard: [
          [{ text: localized(context.language, '🏷 Категория', '🏷 Toifa', '🏷 Category'), callback_data: 'v1:txcats:0' }, { text: localized(context.language, '💳 Карта', '💳 Karta', '💳 Card'), callback_data: 'v1:txcards:0' }],
          [{ text: localized(context.language, '💰 Сумма', '💰 Summa', '💰 Amount'), callback_data: 'v1:field:0:amt' }, { text: localized(context.language, '💬 Комментарий', '💬 Izoh', '💬 Comment'), callback_data: 'v1:field:0:com' }],
          [{ text: localized(context.language, '📅 Дата', '📅 Sana', '📅 Date'), callback_data: 'v1:field:0:dat' }],
          [{ text: localized(context.language, '🗑 Удалить', '🗑 O‘chirish', '🗑 Delete'), callback_data: 'v1:del:0' }],
          [{ text: localized(context.language, '⬅️ Готово', '⬅️ Tayyor', '⬅️ Done'), callback_data: 'v1:back:0' }],
        ] } },
      );
      answer = '';
      return context.uid;
    } else if (action === 'field' && optionRaw && ['amt', 'com', 'dat'].includes(optionRaw)) {
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
      await editMessageText(input.chatId, input.messageId,
        `❓ Требуется уточнение\n\n${escapeHtml(draft.sourceText)}`,
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
      transaction.cardId = cardId;
      reasons = without(reasons, ['INSUFFICIENT_FUNDS', 'NO_CARD_IN_CURRENCY', 'AMBIGUOUS_CARD_HINT', 'NO_CARDS']);
    } else if (action === 'conf') {
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
      answer = await confirm(context.uid, input.chatId, input.messageId, updated, context.language);
    } else {
      const keyboard = await remainingKeyboard(reasons, updated, message, context.language);
      await editMessageText(input.chatId, input.messageId,
        `❓ Требуется уточнение\n\n${escapeHtml(draft.sourceText)}`,
        { reply_markup: keyboard },
      );
      answer = 'Обновлено';
    }
    return context.uid;
  } finally {
    await answerCallbackQuery(input.id, answer || undefined).catch(() => undefined);
  }
}
