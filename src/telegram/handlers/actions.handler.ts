import { env } from '../../config/env';
import { db } from '../../config/firebase';
import { calcDebtTotal } from '../../domain/debt';
import type { Card } from '../../domain/types';
import { safe } from '../../notifications/format';
import { dateKey } from '../../notifications/schedule';
import { renderNotification } from '../../notifications/render/blocks';
import { setNotificationsEnabled } from '../../notifications/settings';
import { payTelegramDebtOnce } from '../../services/debt.service';
import { payTelegramSubscriptionOnce } from '../../services/subscription.service';
import { editMessageText } from '../client';
import {
  completeNotificationAction,
  type TelegramMessageContext,
  updateMessageOptions,
} from '../messages.repository';
import type { SupportedLanguage } from '../types';
import type { TelegramUserContext } from '../context';
import { resolveCard } from '../resolve/card';
import { logger } from '../../utils/logger';

const actions = new Set(['paysub', 'psok', 'paydebt', 'pdok', 'notback', 'notifyoff', 'notifyon']);

export function isNotificationAction(action: string): boolean {
  return actions.has(action);
}

const localized = (language: SupportedLanguage, ru: string, uz: string, en: string) =>
  language === 'uz' ? uz : language === 'en' ? en : ru;

function available(card: Card): number {
  return card.cardType === 'credit' ? Number(card.limit ?? 0) - card.balance : card.balance;
}

async function cardsFor(
  uid: string,
  currency: string,
  amount: number,
  type: 'income' | 'expense' = 'expense',
): Promise<Card[]> {
  const [cardsSnapshot, recentSnapshot] = await Promise.all([
    db.collection('cards').where('userId', '==', uid).get(),
    db.collection('transactions').where('userId', '==', uid).limit(50).get(),
  ]);
  const recentIds = recentSnapshot.docs
    .sort((left, right) => Number(right.data().createdAt ?? 0) - Number(left.data().createdAt ?? 0))
    .map((document) => String(document.data().cardId ?? ''))
    .filter(Boolean);
  const allCards = cardsSnapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as Card);
  const preferred = resolveCard({ cardHint: '' }, allCards, recentIds, amount, currency as Card['currency'], type).cardId;
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  return allCards
    .filter((card) => card.currency === currency)
    .sort((left, right) => Number(right.id === preferred) - Number(left.id === preferred)
      || (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || Number(available(right) >= amount) - Number(available(left) >= amount)
      || right.createdAt - left.createdAt);
}

function cardRows(
  cards: Card[],
  amount: number,
  action: 'psok' | 'pdok',
  itemIndex: number,
  language: SupportedLanguage,
) {
  const rows = cards.slice(0, 6).map((card, cardIndex) => [{
    text: `${available(card) < amount ? '⚠️ ' : '💳 '}${card.name} · ${available(card).toLocaleString('ru-RU')}`,
    callback_data: `v1:${action}:${itemIndex}:${cardIndex}`,
  }]);
  rows.push([{
    text: localized(language, '⬅️ Назад', '⬅️ Orqaga', '⬅️ Back'),
    callback_data: `v1:notback:${itemIndex}`,
  }]);
  return rows;
}

async function restoreNotification(
  input: ActionInput,
  message: TelegramMessageContext,
  completedActions = message.notification?.completedActions ?? [],
): Promise<void> {
  if (!message.notification) return;
  const rendered = renderNotification(
    message.notification.payload,
    input.context.language,
    message.notification.introIncluded,
    completedActions,
  );
  await editMessageText(input.chatId, input.messageId, rendered.text, { reply_markup: rendered.keyboard });
}

interface ActionInput {
  action: string;
  itemIndex: number;
  optionIndex?: number;
  chatId: string;
  messageId: number;
  context: TelegramUserContext;
  message: TelegramMessageContext;
}

export async function handleNotificationAction(input: ActionInput): Promise<string> {
  const { action, itemIndex, context, message } = input;
  try {
    if (action === 'notifyoff') {
      await setNotificationsEnabled(context.uid, false);
      await editMessageText(input.chatId, input.messageId, localized(context.language,
        '🔕 Напоминания Pulim отключены.', '🔕 Pulim eslatmalari o‘chirildi.', '🔕 Pulim reminders are off.'), {
        reply_markup: { inline_keyboard: [[{
          text: localized(context.language, '🔔 Включить обратно', '🔔 Qayta yoqish', '🔔 Enable again'),
          callback_data: 'v1:notifyon:0',
        }]] },
      });
      return localized(context.language, 'Отключено', 'O‘chirildi', 'Disabled');
    }
    if (action === 'notifyon') {
      await setNotificationsEnabled(context.uid, true);
      await editMessageText(input.chatId, input.messageId, localized(context.language,
        '🔔 Напоминания Pulim снова включены.', '🔔 Pulim eslatmalari qayta yoqildi.', '🔔 Pulim reminders are on again.'));
      return localized(context.language, 'Включено', 'Yoqildi', 'Enabled');
    }
    if (action === 'notback') {
      await restoreNotification(input, message);
      return '';
    }

    const item = message.items[itemIndex];
    if (!item || !message.notification) return localized(context.language, 'Кнопка устарела', 'Tugma eskirgan', 'Button expired');
    if (message.notification.completedActions?.includes(itemIndex)) {
      await restoreNotification(input, message);
      return localized(context.language, 'Уже оплачено', 'Allaqachon to‘langan', 'Already paid');
    }

    if (action === 'paysub' && item.subscriptionId && item.expectedNextBillingDate) {
      const snapshot = await db.collection('subscriptions').doc(item.subscriptionId).get();
      if (!snapshot.exists || snapshot.data()!.userId !== context.uid) return localized(context.language, 'Подписка не найдена', 'Obuna topilmadi', 'Subscription not found');
      const subscription = snapshot.data()!;
      if (Number(subscription.nextBillingDate) !== item.expectedNextBillingDate) {
        const completed = await completeNotificationAction(input.chatId, input.messageId, itemIndex);
        await restoreNotification(input, message, completed);
        return localized(context.language, 'Уже оплачено', 'Allaqachon to‘langan', 'Already paid');
      }
      const cards = await cardsFor(context.uid, String(subscription.currency), Number(subscription.amount));
      await updateMessageOptions(input.chatId, input.messageId, { categoryIds: [], cardIds: cards.map((card) => card.id), page: 0 });
      await editMessageText(input.chatId, input.messageId, localized(context.language,
        `Подтвердите оплату ${safe(subscription.name)}: ${Number(subscription.amount).toLocaleString('ru-RU')} ${subscription.currency}. Выберите счёт:`,
        `${safe(subscription.name)} uchun ${Number(subscription.amount).toLocaleString('ru-RU')} ${subscription.currency} to‘lovini tasdiqlang. Hisobni tanlang:`,
        `Confirm ${safe(subscription.name)}: ${Number(subscription.amount).toLocaleString('en-GB')} ${subscription.currency}. Choose an account:`), {
        reply_markup: { inline_keyboard: cardRows(cards, Number(subscription.amount), 'psok', itemIndex, context.language) },
      });
      return '';
    }

    if (action === 'paydebt' && item.debtId) {
      const snapshot = await db.collection('debts').doc(item.debtId).get();
      if (!snapshot.exists || snapshot.data()!.userId !== context.uid) return localized(context.language, 'Долг не найден', 'Qarz topilmadi', 'Debt not found');
      const debt = snapshot.data()!;
      const remaining = Math.max(0, calcDebtTotal(Number(debt.amount), debt.commission) - Number(debt.paidAmount ?? 0));
      if (debt.isPaid || remaining <= 0) {
        const completed = await completeNotificationAction(input.chatId, input.messageId, itemIndex);
        await restoreNotification(input, message, completed);
        return localized(context.language, 'Уже погашено', 'Allaqachon yopilgan', 'Already settled');
      }
      const cards = await cardsFor(context.uid, String(debt.currency), remaining, debt.direction === 'owe_me' ? 'income' : 'expense');
      await updateMessageOptions(input.chatId, input.messageId, { categoryIds: [], cardIds: cards.map((card) => card.id), page: 0 });
      await editMessageText(input.chatId, input.messageId, localized(context.language,
        `Подтвердите погашение долга: ${remaining.toLocaleString('ru-RU')} ${debt.currency}. Выберите счёт:`,
        `Qarzni yopishni tasdiqlang: ${remaining.toLocaleString('ru-RU')} ${debt.currency}. Hisobni tanlang:`,
        `Confirm debt settlement: ${remaining.toLocaleString('en-GB')} ${debt.currency}. Choose an account:`), {
        reply_markup: { inline_keyboard: cardRows(cards, remaining, 'pdok', itemIndex, context.language) },
      });
      return '';
    }

    const cardId = message.options?.cardIds[input.optionIndex ?? -1];
    if (!cardId) return localized(context.language, 'Счёт недоступен', 'Hisob mavjud emas', 'Account unavailable');
    if (action === 'psok' && item.subscriptionId && item.expectedNextBillingDate) {
      const result = await payTelegramSubscriptionOnce(context.uid, {
        subscriptionId: item.subscriptionId,
        accountId: cardId,
        expectedNextBillingDate: item.expectedNextBillingDate,
      }, `notify:sub:${item.subscriptionId}:${dateKey(item.expectedNextBillingDate, env.NOTIFY_TIMEZONE)}`);
      const completed = await completeNotificationAction(input.chatId, input.messageId, itemIndex);
      await restoreNotification(input, message, completed);
      return result.created
        ? localized(context.language, 'Оплачено', 'To‘landi', 'Paid')
        : localized(context.language, 'Уже оплачено', 'Allaqachon to‘langan', 'Already paid');
    }
    if (action === 'pdok' && item.debtId) {
      const snapshot = await db.collection('debts').doc(item.debtId).get();
      if (!snapshot.exists || snapshot.data()!.userId !== context.uid) return localized(context.language, 'Долг не найден', 'Qarz topilmadi', 'Debt not found');
      const debt = snapshot.data()!;
      const remaining = Math.max(0, calcDebtTotal(Number(debt.amount), debt.commission) - Number(debt.paidAmount ?? 0));
      if (debt.isPaid || remaining <= 0) {
        const completed = await completeNotificationAction(input.chatId, input.messageId, itemIndex);
        await restoreNotification(input, message, completed);
        return localized(context.language, 'Уже погашено', 'Allaqachon yopilgan', 'Already settled');
      }
      let result: Awaited<ReturnType<typeof payTelegramDebtOnce>>;
      try {
        result = await payTelegramDebtOnce(context.uid, {
          debtId: item.debtId, amount: remaining, accountId: cardId,
        }, `notify:debt:${item.debtId}:${input.messageId}`);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Debt is already paid.') throw error;
        const completed = await completeNotificationAction(input.chatId, input.messageId, itemIndex);
        await restoreNotification(input, message, completed);
        return localized(context.language, 'Уже погашено', 'Allaqachon yopilgan', 'Already settled');
      }
      const completed = await completeNotificationAction(input.chatId, input.messageId, itemIndex);
      await restoreNotification(input, message, completed);
      return result.created
        ? localized(context.language, 'Погашено', 'Yopildi', 'Settled')
        : localized(context.language, 'Уже погашено', 'Allaqachon yopilgan', 'Already settled');
    }
    return localized(context.language, 'Кнопка устарела', 'Tugma eskirgan', 'Button expired');
  } catch (error) {
    logger.warn({ err: error, uid: context.uid, action }, 'notify.action.failed');
    return localized(context.language, 'Не удалось выполнить действие', 'Amalni bajarib bo‘lmadi', 'Could not complete the action');
  }
}
