import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { env } from '../config/env';
import { db } from '../config/firebase';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories';
import type { Card, Category, Commission, Debt, Subcategory, Transaction } from '../domain/types';
import { calcDebtTotal } from '../domain/debt';
import {
  answerStatelessChat, assembleSnapshot, consumeAiMessage, refundAiMessage, selectChatModel,
} from '../services/ai.service';
import { createTelegramDebtOnce, payTelegramDebtOnce } from '../services/debt.service';
import { getRateToBase } from '../services/fxRates.service';
import { createTelegramTransactionOnce } from '../services/transaction.service';
import { logger } from '../utils/logger';
import { aliasesForCategory, categoryDisplayName } from './categoryAliases';
import { deleteMessage, editMessageText, sendMessage, sendMessageDraft } from './client';
import { createDraft, updateDraft } from './drafts.repository';
import { t } from './i18n';
import type { BudgetLoadingMessage } from './loadingDraft.service';
import { parseMessage, TelegramParseError } from './parser.service';
import { escapeHtml, markdownToTelegramHtml, premiumKeyboard } from './render';
import { saveMessage } from './messages.repository';
import { resolveAmount } from './resolve/amount';
import { resolveCard, resolveCardHint } from './resolve/card';
import { resolveCategory } from './resolve/category';
import { resolveDate, resolveDueDate } from './resolve/date';
import type { DraftReason, ParsedOperationKind, SupportedLanguage } from './types';

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

export async function loadCatalog(uid: string, language: SupportedLanguage) {
  const cutoff = Date.now() - 90 * 86_400_000;
  const [categories, subcategories, cards, transactions, debts] = await Promise.all([
    owned<Category>('categories', uid),
    owned<Subcategory>('subcategories', uid),
    owned<Card>('cards', uid),
    owned<Transaction>('transactions', uid),
    owned<Debt>('debts', uid),
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
    '',
    'ACTIVE DEBTS (id | direction | person | principal | paid | remaining | currency | commission | dueDate | comment):',
    ...debts.filter((debt) => !debt.isPaid).map((debt) => {
      const commission = debt.commission ? `${debt.commission.type}:${debt.commission.value}` : '-';
      const remaining = Math.max(0, calcDebtTotal(debt.amount, debt.commission) - debt.paidAmount);
      return [debt.id, debt.direction, clean(debt.person), debt.amount, debt.paidAmount, remaining,
        debt.currency, commission, debt.dueDate ? dayjs(debt.dueDate).tz(env.TELEGRAM_DEFAULT_TIMEZONE).format('YYYY-MM-DD') : '-', clean(debt.comment)].join(' | ');
    }),
  ];
  return { categories, subcategories, cards, debts, recentCardIds, prompt: lines.join('\n') };
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

interface SavedTelegramOperation {
  kind: ParsedOperationKind;
  transactionId?: string;
  debtId?: string;
  transaction?: Record<string, unknown>;
  debt?: Record<string, unknown>;
  payment?: Record<string, unknown>;
}

export function formatDate(date: unknown, language: SupportedLanguage): string {
  const value = Number(date);
  if (!Number.isFinite(value)) return localized(language, 'дата не указана', 'sana ko‘rsatilmagan', 'date not specified');
  const locale = language === 'uz' ? 'uz-UZ' : language === 'en' ? 'en-US' : 'ru-RU';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: env.TELEGRAM_DEFAULT_TIMEZONE,
  }).format(new Date(value));
}

function catalogCategory(catalog: { categories: Category[] }, id: unknown, language: SupportedLanguage): string {
  const category = catalog.categories.find((candidate) => candidate.id === String(id ?? ''));
  return category ? `${category.icon} ${categoryDisplayName(category, language)}` : localized(language, 'Не указана', 'Ko‘rsatilmagan', 'Not specified');
}

function catalogSubcategory(catalog: { subcategories: Subcategory[] }, categoryId: unknown, id: unknown): string | null {
  const subcategory = catalog.subcategories.find((candidate) =>
    candidate.id === String(id ?? '') && candidate.categoryId === String(categoryId ?? ''));
  return subcategory?.name ?? null;
}

function catalogCard(catalog: { cards: Card[] }, id: unknown, _language: SupportedLanguage): string | null {
  const card = catalog.cards.find((candidate) => candidate.id === String(id ?? ''));
  return card ? `${card.name}${card.bank ? ` · ${card.bank}` : ''}` : null;
}

export function formatSavedTransaction(
  transaction: Record<string, unknown>,
  catalog: { categories: Category[]; subcategories: Subcategory[]; cards: Card[] },
  language: SupportedLanguage,
): string {
  const income = transaction.type === 'income';
  const card = catalogCard(catalog, transaction.cardId, language);
  const lines = [
    ...(card ? [] : [`ℹ️ ${localized(language, 'Карта не указана — при желании выберите её в приложении, чтобы связать запись с балансом.', 'Karta ko‘rsatilmagan — xohlasangiz, ilovada uni tanlab yozuvni balans bilan bog‘lang.', 'No card was specified — you can choose one in the app later to link this entry to a balance.')}`, '']),
    income
      ? localized(language, '✅ Доход сохранён', '✅ Daromad saqlandi', '✅ Income saved')
      : localized(language, '✅ Транзакция сохранена', '✅ Tranzaksiya saqlandi', '✅ Transaction saved'),
    '',
    `${income ? '📥' : '💸'} ${income ? localized(language, 'Доход', 'Daromad', 'Income') : localized(language, 'Расход', 'Xarajat', 'Expense')}: ${formatAmount(Number(transaction.amount), String(transaction.currency), language)}`,
    `🏷 ${localized(language, 'Категория', 'Toifa', 'Category')}: ${escapeHtml(catalogCategory(catalog, transaction.categoryId, language))}`,
  ];
  const subcategory = catalogSubcategory(catalog, transaction.categoryId, transaction.subcategoryId);
  if (subcategory) lines.push(`🍽 ${localized(language, 'Подкатегория', 'Ichki toifa', 'Subcategory')}: ${escapeHtml(subcategory)}`);
  lines.push(`💬 ${localized(language, 'Комментарий', 'Izoh', 'Comment')}: ${transaction.comment ? escapeHtml(transaction.comment) : '—'}`);
  lines.push(`📅 ${localized(language, 'Дата', 'Sana', 'Date')}: ${formatDate(transaction.date, language)}`);
  if (card) {
    lines.push(`💳 ${localized(language, 'Карта', 'Karta', 'Card')}: ${escapeHtml(card)}`);
  } else {
    lines.push(`💳 ${localized(language, 'Карта', 'Karta', 'Card')}: ${localized(language, 'не указана', 'ko‘rsatilmagan', 'not specified')}`);
    lines.push(`ℹ️ ${localized(language, 'Баланс не изменён — карта не была указана.', 'Balans o‘zgarmadi — karta ko‘rsatilmagan.', 'The balance was not changed because no card was specified.')}`);
  }
  return lines.join('\n');
}

export function formatSavedTransfer(
  transaction: Record<string, unknown>,
  catalog: { cards: Card[] },
  language: SupportedLanguage,
): string {
  const from = catalogCard(catalog, transaction.cardId, language)
    ?? localized(language, 'не указана', 'ko‘rsatilmagan', 'not specified');
  const to = catalogCard(catalog, transaction.toCardId, language)
    ?? localized(language, 'не указана', 'ko‘rsatilmagan', 'not specified');
  const lines = [
    localized(language, '✅ Перевод сохранён', '✅ O‘tkazma saqlandi', '✅ Transfer saved'),
    '',
    `📤 ${localized(language, 'С карты', 'Kartadan', 'From')}: ${escapeHtml(from)}`,
    `📥 ${localized(language, 'На карту', 'Kartaga', 'To')}: ${escapeHtml(to)}`,
    `💸 ${localized(language, 'Отправлено', 'Yuborildi', 'Sent')}: ${formatAmount(Number(transaction.amount), String(transaction.currency), language)}`,
    `💰 ${localized(language, 'Зачислено', 'Tushdi', 'Received')}: ${formatAmount(Number(transaction.toAmount ?? transaction.amount), String(transaction.toCurrency ?? transaction.currency), language)}`,
    `📅 ${localized(language, 'Дата', 'Sana', 'Date')}: ${formatDate(transaction.date, language)}`,
  ];
  if (transaction.fxRate) {
    lines.push(`🔄 ${localized(language, 'Курс НБУ', 'NBU kursi', 'NBU rate')}: 1 ${escapeHtml(String(transaction.currency))} = ${Number(transaction.fxRate).toLocaleString('ru-RU')} UZS`);
  } else if (transaction.fxRateSource === 'manual') {
    lines.push(`🔄 ${localized(language, 'Сумма зачисления указана вручную.', 'Tushgan summa qo‘lda ko‘rsatildi.', 'The received amount was entered manually.')}`);
  }
  if (transaction.comment) lines.push(`💬 ${localized(language, 'Комментарий', 'Izoh', 'Comment')}: ${escapeHtml(transaction.comment)}`);
  return lines.join('\n');
}

export function formatSavedDebt(
  debt: Record<string, unknown>,
  catalog: { cards: Card[] },
  language: SupportedLanguage,
): string {
  const directionLabel = debt.direction === 'owe_me'
    ? localized(language, 'должны вам', 'sizga qarzdor', 'owes you')
    : debt.direction === 'i_owe'
      ? localized(language, 'вы должны', 'siz qarzdorsiz', 'you owe')
      : localized(language, 'направление не указано', 'yo‘nalish ko‘rsatilmagan', 'direction not specified');
  const commission = debt.commission as Commission | undefined;
  const principal = Number(debt.amount);
  const total = calcDebtTotal(principal, commission);
  const card = catalogCard(catalog, debt.accountId, language);
  const lines = [
    ...(card ? [] : [`ℹ️ ${localized(language, 'Карта не указана — долг сохранится, но баланс не изменится. При необходимости проверьте и дополните запись в приложении.', 'Karta ko‘rsatilmagan — qarz saqlanadi, lekin balans o‘zgarmaydi. Zarur bo‘lsa, ilovada yozuvni tekshiring va to‘ldiring.', 'No card was specified — the debt will be saved, but the balance will not change. You can review and complete the entry in the app if needed.')}`, '']),
    localized(language, '✅ Долг добавлен', '✅ Qarz qo‘shildi', '✅ Debt added'),
    '',
    `👤 ${escapeHtml(debt.person || localized(language, 'имя не указано', 'ism ko‘rsatilmagan', 'name not specified'))} — ${directionLabel}`,
    `💰 ${localized(language, 'Основная сумма', 'Asosiy summa', 'Principal')}: ${formatAmount(principal, String(debt.currency), language)}`,
  ];
  if (commission) {
    lines.push(`➕ ${localized(language, 'Комиссия', 'Komissiya', 'Commission')}: ${commission.type === 'percent'
      ? `${commission.value}%`
      : formatAmount(commission.value, String(debt.currency), language)}`);
  }
  lines.push(`🧮 ${localized(language, 'Итого к возврату', 'Qaytariladigan jami', 'Total to repay')}: ${formatAmount(total, String(debt.currency), language)}`);
  if (debt.dueDate) lines.push(`📅 ${localized(language, 'Срок', 'Muddat', 'Due date')}: ${formatDate(debt.dueDate, language)}`);
  if (debt.comment) lines.push(`💬 ${localized(language, 'Комментарий', 'Izoh', 'Comment')}: ${escapeHtml(debt.comment)}`);
  if (card) {
    lines.push(`💳 ${localized(language, 'Карта', 'Karta', 'Card')}: ${escapeHtml(card)}`);
  } else {
    lines.push(`ℹ️ ${localized(language, 'Долг сохранён без карты: баланс не изменён. При необходимости дополните запись в приложении.', 'Qarz kartasiz saqlandi: balans o‘zgarmadi. Zarur bo‘lsa, yozuvni ilovada to‘ldiring.', 'The debt was saved without a card, so no balance was changed. You can complete the entry in the app if needed.')}`);
  }
  return lines.join('\n');
}

export function formatSavedDebtPayment(
  payment: Record<string, unknown>,
  catalog: { cards: Card[] },
  language: SupportedLanguage,
): string {
  const directionLabel = payment.direction === 'owe_me'
    ? localized(language, 'вам вернули', 'sizga qaytarildi', 'repaid to you')
    : payment.direction === 'i_owe'
      ? localized(language, 'вы вернули', 'siz qaytardingiz', 'you repaid')
      : localized(language, 'направление не указано', 'yo‘nalish ko‘rsatilmagan', 'direction not specified');
  const remaining = Math.max(0, Number(payment.total) - Number(payment.paidAmount));
  const card = catalogCard(catalog, payment.accountId, language);
  const lines = [
    ...(card ? [] : [`ℹ️ ${localized(language, 'Карта не указана — платёж сохранится, но баланс не изменится. При необходимости проверьте запись в приложении.', 'Karta ko‘rsatilmagan — to‘lov saqlanadi, lekin balans o‘zgarmaydi. Zarur bo‘lsa, yozuvni ilovada tekshiring.', 'No card was specified — the payment will be saved, but the balance will not change. You can review the entry in the app if needed.')}`, '']),
    payment.isPaid
      ? localized(language, '✅ Долг полностью погашен', '✅ Qarz to‘liq yopildi', '✅ Debt fully paid')
      : localized(language, '✅ Платёж по долгу сохранён', '✅ Qarz to‘lovi saqlandi', '✅ Debt payment saved'),
    '',
    `👤 ${escapeHtml(payment.person || localized(language, 'имя не указано', 'ism ko‘rsatilmagan', 'name not specified'))} — ${directionLabel}`,
    `💸 ${localized(language, 'Платёж', 'To‘lov', 'Payment')}: ${formatAmount(Number(payment.amount), String(payment.currency), language)}`,
    `📊 ${localized(language, 'Осталось', 'Qoldi', 'Remaining')}: ${formatAmount(remaining, String(payment.currency), language)}`,
  ];
  if (payment.date) lines.push(`📅 ${localized(language, 'Дата', 'Sana', 'Date')}: ${formatDate(payment.date, language)}`);
  if (card) lines.push(`💳 ${localized(language, 'Карта', 'Karta', 'Card')}: ${escapeHtml(card)}`);
  else lines.push(`ℹ️ ${localized(language, 'Платёж сохранён без карты: баланс не изменён. При необходимости дополните запись в приложении.', 'To‘lov kartasiz saqlandi: balans o‘zgarmadi. Zarur bo‘lsa, yozuvni ilovada to‘ldiring.', 'The payment was saved without a card, so no balance was changed. You can complete the entry in the app if needed.')}`);
  return lines.join('\n');
}

export function reasonText(reason: DraftReason, language: SupportedLanguage): string {
  const messages: Record<DraftReason, [string, string, string]> = {
    AMBIGUOUS_SMALL_AMOUNT: ['Сумма может быть указана в тысячах. Выберите вариант.', 'Summa minglarda ko‘rsatilgan bo‘lishi mumkin. Variantni tanlang.', 'The amount may be in thousands. Choose an option.'],
    AMOUNT_MISMATCH: ['Я увидел два разных варианта суммы. Выберите правильный.', 'Ikki xil summa aniqlandi. To‘g‘ri variantni tanlang.', 'I found two different amounts. Choose the correct one.'],
    LOW_AMOUNT_CONFIDENCE: ['Сумму лучше проверить.', 'Summani tekshirib olish yaxshi.', 'The amount is worth checking.'],
    NO_CATEGORY_MATCH: ['Категорию нужно выбрать.', 'Toifani tanlash kerak.', 'A category needs to be selected.'],
    LOW_CATEGORY_CONFIDENCE: ['Категорию лучше проверить.', 'Toifani tekshirib olish yaxshi.', 'The category is worth checking.'],
    INSUFFICIENT_FUNDS: ['На выбранной карте может не хватить средств.', 'Tanlangan kartada mablag‘ yetmasligi mumkin.', 'The selected card may not have enough funds.'],
    NO_CARD_IN_CURRENCY: ['Не нашлась карта в этой валюте.', 'Bu valyutada karta topilmadi.', 'No card in this currency was found.'],
    AMBIGUOUS_CARD_HINT: ['Я нашёл несколько похожих карт.', 'Bir nechta o‘xshash karta topildi.', 'I found several similar cards.'],
    NO_CARDS: ['Карта не указана.', 'Karta ko‘rsatilmagan.', 'No card was specified.'],
    DATE_IN_FUTURE: ['Дата выглядит будущей — проверьте её.', 'Sana kelajakdagi ko‘rinadi — tekshiring.', 'The date appears to be in the future.'],
    AMBIGUOUS_TYPE: ['Не до конца понял: это доход или расход.', 'Bu daromadmi yoki xarajatmi — aniq emas.', 'I am not fully sure whether this is income or expense.'],
    FX_UNAVAILABLE: ['Курс временно недоступен.', 'Kurs vaqtincha mavjud emas.', 'The exchange rate is temporarily unavailable.'],
    NO_SOURCE_CARD: ['Не указана карта, с которой отправляются деньги.', 'Pul qaysi kartadan yuborilishi ko‘rsatilmagan.', 'The card sending the money was not specified.'],
    NO_DESTINATION_CARD: ['Не указана карта, на которую зачисляются деньги.', 'Pul qaysi kartaga tushishi ko‘rsatilmagan.', 'The destination card was not specified.'],
    AMBIGUOUS_SOURCE_CARD: ['Нашлось несколько возможных карт-источников.', 'Bir nechta manba karta topildi.', 'Several possible source cards were found.'],
    AMBIGUOUS_DESTINATION_CARD: ['Нашлось несколько возможных карт назначения.', 'Bir nechta qabul qiluvchi karta topildi.', 'Several possible destination cards were found.'],
    TRANSFER_SAME_CARD: ['Карты отправления и назначения должны отличаться.', 'Yuboruvchi va qabul qiluvchi kartalar turlicha bo‘lishi kerak.', 'The source and destination cards must be different.'],
    NO_TO_AMOUNT: ['Не удалось определить сумму зачисления.', 'Tushadigan summa aniqlanmadi.', 'The received amount could not be determined.'],
    NO_DEBT_MATCH: ['Не нашёл подходящий активный долг.', 'Mos faol qarz topilmadi.', 'I could not find a matching active debt.'],
    AMBIGUOUS_DEBT: ['Нашлось несколько похожих долгов.', 'Bir nechta o‘xshash qarz topildi.', 'Several similar debts were found.'],
    DEBT_ALREADY_PAID: ['Этот долг уже погашен.', 'Bu qarz allaqachon yopilgan.', 'This debt is already paid.'],
    DEBT_PAYMENT_TOO_LARGE: ['Сумма больше остатка по долгу.', 'To‘lov summasi qarz qoldig‘idan katta.', 'The payment is larger than the remaining debt.'],
    MISSING_PERSON: ['Не понял, о ком именно речь.', 'Kim haqida gap ketayotganini tushunmadim.', 'I could not identify the person.'],
    AMBIGUOUS_DEBT_DIRECTION: ['Не понял, кто кому должен. Уточните формулировку.', 'Kim kimga qarzdorligini tushunmadim.', 'I could not tell who owes whom.'],
  };
  const value = messages[reason];
  return localized(language, value[0], value[1], value[2]);
}

export function formatDraftOperation(
  kind: ParsedOperationKind,
  draft: Record<string, unknown>,
  catalog: { categories: Category[]; subcategories: Subcategory[]; cards: Card[] },
  language: SupportedLanguage,
  reasons: DraftReason[],
): string {
  const lines = [
    localized(language, '🔎 Проверьте, пожалуйста, детали', '🔎 Tafsilotlarni tekshiring', '🔎 Please check the details'),
    '',
  ];
  if (kind === 'transfer' && reasons.some((reason) => ['NO_SOURCE_CARD', 'NO_DESTINATION_CARD', 'AMBIGUOUS_SOURCE_CARD', 'AMBIGUOUS_DESTINATION_CARD'].includes(reason))) {
    lines.unshift(
      localized(language, 'ℹ️ В сообщении не указана одна или обе карты. Выберите их ниже, чтобы перевод был сохранён правильно.', 'ℹ️ Xabarda bir yoki ikkala karta ko‘rsatilmagan. O‘tkazmani to‘g‘ri saqlash uchun quyida ularni tanlang.', 'ℹ️ One or both cards were not specified. Choose them below so the transfer can be saved correctly.'),
      '',
    );
  }
  if (kind === 'transaction') {
    lines.push(...formatSavedTransaction(draft, catalog, language).split('\n').slice(2));
  } else if (kind === 'transfer') {
    lines.push(...formatSavedTransfer(draft, catalog, language).split('\n').slice(2));
  } else if (kind === 'debt') {
    lines.push(...formatSavedDebt(draft, catalog, language).split('\n').slice(2));
  } else {
    lines.push(...formatSavedDebtPayment(draft, catalog, language).split('\n').slice(2));
  }
  if (reasons.length) {
    lines.push('', `⚠️ ${localized(language, 'Что нужно уточнить', 'Nimani aniqlashtirish kerak', 'Needs attention')}:`);
    for (const reason of [...new Set(reasons)]) lines.push(`• ${reasonText(reason, language)}`);
  }
  return lines.join('\n');
}

const hardDraftReasons = new Set<DraftReason>([
  'AMBIGUOUS_SMALL_AMOUNT', 'AMOUNT_MISMATCH', 'NO_CATEGORY_MATCH', 'NO_CARD_IN_CURRENCY',
  'AMBIGUOUS_CARD_HINT', 'FX_UNAVAILABLE', 'NO_SOURCE_CARD', 'NO_DESTINATION_CARD',
  'AMBIGUOUS_SOURCE_CARD', 'AMBIGUOUS_DESTINATION_CARD', 'TRANSFER_SAME_CARD', 'NO_TO_AMOUNT',
  'NO_DEBT_MATCH', 'AMBIGUOUS_DEBT', 'DEBT_ALREADY_PAID', 'DEBT_PAYMENT_TOO_LARGE', 'MISSING_PERSON', 'AMBIGUOUS_DEBT_DIRECTION',
  'DATE_IN_FUTURE',
]);

async function sendPendingDraft(input: {
  uid: string;
  chatId: string;
  messageId: number;
  index: number;
  operationKey: string;
  sourceText: string;
  operationType: ParsedOperationKind;
  draft: Record<string, unknown>;
  reasons: DraftReason[];
  amountAlternative: number | null;
  suggestion: { categoryName: string; categoryIcon: string } | null;
  catalog: { categories: Category[]; cards: Card[]; subcategories: Subcategory[] };
  language: SupportedLanguage;
  isPremium: boolean;
}): Promise<void> {
  const draft = await createDraft({
    userId: input.uid,
    chatId: input.chatId,
    sourceMessageId: input.messageId,
    sourceText: input.sourceText,
    index: input.index,
    operationKey: input.operationKey,
    operationType: input.operationType,
    draft: input.draft,
    amountAlternative: input.amountAlternative,
    suggestion: input.suggestion,
    reasons: input.reasons,
  });
  logger.info({ uid: input.uid, draftId: draft.id, operationType: input.operationType, reasons: input.reasons }, 'telegram.draft.created');
  if (draft.botMessageId) return;

  const categoryIds = input.operationType === 'transaction'
    ? input.catalog.categories
      .filter((candidate) => candidate.type === input.draft.type || candidate.type === 'both')
      .map((candidate) => candidate.id)
    : [];
  const cardIds = input.catalog.cards.map((candidate) => candidate.id);
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  const amountAlternative = input.amountAlternative;
  if (input.operationType === 'transaction' && input.reasons.some((reason) => ['AMBIGUOUS_SMALL_AMOUNT', 'AMOUNT_MISMATCH'].includes(reason)) && amountAlternative) {
    keyboard.push([
      { text: formatAmount(Number(input.draft.amount), String(input.draft.currency), input.language), callback_data: 'v1:amt:0:0' },
      { text: formatAmount(amountAlternative, String(input.draft.currency), input.language), callback_data: 'v1:amt:0:1' },
    ]);
  }
  if (input.operationType === 'transaction' && input.reasons.includes('NO_CATEGORY_MATCH')) {
    categoryIds.slice(0, 6).forEach((id, optionIndex) => {
      const category = input.catalog.categories.find((entry) => entry.id === id)!;
      keyboard.push([{ text: `${category.icon} ${categoryDisplayName(category, input.language)}`, callback_data: `v1:cat:0:${optionIndex}` }]);
    });
    if (input.isPremium && input.suggestion?.categoryName) {
      keyboard.push([{ text: `➕ ${input.suggestion.categoryName}`, callback_data: 'v1:newcat:0' }]);
    }
    if (categoryIds.length > 6) keyboard.push([{ text: localized(input.language, '⬇️ Ещё категории', '⬇️ Yana toifalar', '⬇️ More categories'), callback_data: 'v1:txcatp:0:1' }]);
  }
  const needsSource = input.operationType === 'transfer'
    && input.reasons.some((reason) => ['NO_SOURCE_CARD', 'AMBIGUOUS_SOURCE_CARD'].includes(reason));
  const needsDestination = input.operationType === 'transfer'
    && input.reasons.some((reason) => ['NO_DESTINATION_CARD', 'AMBIGUOUS_DESTINATION_CARD'].includes(reason));
  const needsDebtCard = ['debt', 'debt_payment'].includes(input.operationType)
    && input.reasons.some((reason) => ['NO_SOURCE_CARD', 'AMBIGUOUS_SOURCE_CARD'].includes(reason));
  const needsNormalCard = input.operationType === 'transaction'
    && input.reasons.some((reason) => ['INSUFFICIENT_FUNDS', 'NO_CARD_IN_CURRENCY', 'AMBIGUOUS_CARD_HINT'].includes(reason));
  if (needsSource || needsNormalCard || needsDebtCard) {
    cardIds.slice(0, 6).forEach((id, optionIndex) => {
      const card = input.catalog.cards.find((entry) => entry.id === id)!;
      keyboard.push([{ text: `${needsSource ? '📤' : '💳'} ${card.name}`, callback_data: needsSource ? `v1:from:0:${optionIndex}` : `v1:card:0:${optionIndex}` }]);
    });
  }
  if (needsDestination) {
    cardIds.slice(0, 6).forEach((id, optionIndex) => {
      const card = input.catalog.cards.find((entry) => entry.id === id)!;
      keyboard.push([{ text: `📥 ${card.name}`, callback_data: `v1:to:0:${optionIndex}` }]);
    });
  }
  if (input.operationType === 'transfer' && input.reasons.includes('NO_TO_AMOUNT')) {
    keyboard.push([{ text: localized(input.language, '💰 Указать сумму зачисления', '💰 Tushgan summani ko‘rsatish', '💰 Enter received amount'), callback_data: 'v1:field:0:toamt' }]);
  }
  if (!input.reasons.some((reason) => hardDraftReasons.has(reason))) {
    keyboard.push([{ text: localized(input.language, '✅ Сохранить', '✅ Saqlash', '✅ Save'), callback_data: 'v1:conf:0' }]);
  }
  keyboard.push([{ text: localized(input.language, '✏️ Изменить', '✏️ Tahrirlash', '✏️ Edit'), callback_data: 'v1:edit:0' }]);
  const sent = await sendMessage(input.chatId, formatDraftOperation(
    input.operationType, input.draft, input.catalog, input.language, input.reasons,
  ), { reply_markup: { inline_keyboard: keyboard } });
  await saveMessage({
    userId: input.uid,
    chatId: input.chatId,
    messageId: sent.message_id,
    kind: 'draft',
    items: [{ draftId: draft.id, transactionId: null }],
    options: { categoryIds, cardIds, page: 0 },
  });
  await updateDraft(draft.id, { botMessageId: sent.message_id, language: input.language });
}

async function answerNonTransaction(
  uid: string,
  chatId: string,
  text: string,
  language: SupportedLanguage,
  updateId: number,
  inputMessageId: number,
  isPremium: boolean,
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
  await consumeAiMessage(uid, isPremium);
  const draftId = Math.abs(updateId % 2_147_483_647) || 1;
  try {
    const snapshot = await assembleSnapshot(uid, language);
    let lastDraftAt = 0;
    let loadingStopped = false;
    const answer = await answerStatelessChat({
      uid, model: selectChatModel(isPremium), snapshot, language, userMessage: text,
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
    await refundAiMessage(uid, isPremium);
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
  isPremium: boolean;
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
      input.isPremium,
      input.loadingMessage,
    );
    return;
  }
  await input.loadingMessage?.stop();
  if (input.loadingMessage) {
    await deleteMessage(input.chatId, input.loadingMessage.messageId).catch(() => undefined);
  }
  if (parsed.items.length === 0) throw new TelegramParseError(new Error('Parser returned no transaction items.'));

  const saved: SavedTelegramOperation[] = [];
  const invalidAmounts: string[] = [];
  let blockedPremiumDebt = false;
  for (const [index, item] of parsed.items.slice(0, env.TELEGRAM_MAX_ITEMS_PER_MESSAGE).entries()) {
    const operationKey = `${input.updateId}:${index + 1}`;
    const kind = item.kind;
    const amount = resolveAmount(item.amountLiteral, item.amount, item.currency);
    const fullRepayment = /(?:полностью|весь|всю|hammasini|to['’`]?liq|full)/iu.test(item.rawText);
    const operationDate = resolveDate(item.dateISO, Date.now(), env.TELEGRAM_DEFAULT_TIMEZONE);

    if (!input.isPremium && kind === 'debt') {
      blockedPremiumDebt = true;
      continue;
    }

    if (kind === 'transaction') {
      if (!Number.isFinite(amount.amount) || amount.amount <= 0 || amount.amount > 1e15) {
        invalidAmounts.push(item.rawText);
        continue;
      }
      const category = resolveCategory(item, catalog.categories, catalog.subcategories, input.language);
      // A card must be named explicitly. Guessing a source card would silently
      // change the user's balance, so an omitted card intentionally stays empty.
      const card = item.cardHint.trim()
        ? resolveCard(item, catalog.cards, catalog.recentCardIds, amount.amount, amount.currency, item.type)
        : { cardId: undefined, ambiguous: false, reason: null as null };
      const reasons: DraftReason[] = [];
      if (amount.reason) reasons.push(amount.reason);
      if (item.amountConfidence < 0.9) reasons.push('LOW_AMOUNT_CONFIDENCE');
      if (category.reason) reasons.push(category.reason);
      if (item.typeConfidence < 0.9) reasons.push('AMBIGUOUS_TYPE');
      if (operationDate.reason) reasons.push(operationDate.reason);
      if (card.reason && card.reason !== 'NO_CARDS') reasons.push(card.reason);
      const transaction: Record<string, unknown> = {
        type: item.type,
        amount: amount.amount,
        currency: amount.currency,
        categoryId: category.categoryId,
        ...(category.subcategoryId ? { subcategoryId: category.subcategoryId } : {}),
        ...(card.cardId ? { cardId: card.cardId } : {}),
        comment: item.comment.slice(0, 80),
        date: operationDate.date,
      };
      if (amount.currency !== 'UZS') {
        const rate = await getRateToBase(amount.currency, operationDate.date);
        if (rate) Object.assign(transaction, { baseAmount: Math.round(amount.amount * rate), fxRate: rate, fxRateSource: 'NBU' });
        else reasons.push('FX_UNAVAILABLE');
      }
      if (reasons.length === 0) {
        const result = await createTelegramTransactionOnce(input.uid, transaction, operationKey);
        saved.push({ kind, transactionId: String(result.transaction.id), transaction: result.transaction });
      } else {
        const onlyFxUnavailable = reasons.length === 1 && reasons[0] === 'FX_UNAVAILABLE';
        if (onlyFxUnavailable) {
          const draft = await createDraft({
            userId: input.uid, chatId: input.chatId, sourceMessageId: input.messageId,
            sourceText: item.rawText, index: index + 1, operationKey, operationType: kind, draft: transaction,
            amountAlternative: amount.alternative ?? (amount.reason === 'AMOUNT_MISMATCH' ? item.amount : null),
            suggestion: category.categoryId ? null : { categoryName: item.suggestedCategoryName.slice(0, 40), categoryIcon: item.suggestedCategoryIcon.slice(0, 8) },
            reasons, status: 'waiting_fx',
          });
          if (!draft.botMessageId) {
            const sent = await sendMessage(input.chatId, t(input.language, 'fx_waiting'));
            await updateDraft(draft.id, { botMessageId: sent.message_id, language: input.language });
          }
        } else {
          await sendPendingDraft({
            uid: input.uid, chatId: input.chatId, messageId: input.messageId, index: index + 1,
            operationKey, sourceText: item.rawText, operationType: kind, draft: transaction, reasons,
            amountAlternative: amount.alternative ?? (amount.reason === 'AMOUNT_MISMATCH' ? item.amount : null),
            suggestion: category.categoryId ? null : { categoryName: item.suggestedCategoryName.slice(0, 40), categoryIcon: item.suggestedCategoryIcon.slice(0, 8) },
            catalog, language: input.language, isPremium: input.isPremium,
          });
        }
      }
      continue;
    }

    if (kind === 'transfer') {
      if (!Number.isFinite(amount.amount) || amount.amount <= 0 || amount.amount > 1e15) {
        invalidAmounts.push(item.rawText);
        continue;
      }
      const from = resolveCardHint(item.fromCardHint || item.cardHint, catalog.cards, 'source');
      const to = resolveCardHint(item.toCardHint, catalog.cards, 'destination');
      const reasons: DraftReason[] = [from.reason, to.reason].filter(Boolean) as DraftReason[];
      const fromCard = from.cardId ? catalog.cards.find((card) => card.id === from.cardId) : undefined;
      const toCard = to.cardId ? catalog.cards.find((card) => card.id === to.cardId) : undefined;
      if (from.cardId && to.cardId && from.cardId === to.cardId) reasons.push('TRANSFER_SAME_CARD');
      const transfer: Record<string, unknown> = {
        kind: 'transfer', type: 'expense', amount: amount.amount, currency: amount.currency,
        cardId: from.cardId, fromCardId: from.cardId, toCardId: to.cardId,
        toCurrency: toCard?.currency ?? item.toCurrency ?? amount.currency,
        toAmount: 0, comment: item.comment.slice(0, 80), date: operationDate.date,
      };
      if (fromCard && toCard) {
        const differentCurrencies = fromCard.currency !== toCard.currency;
        let receivedAmountWasSpecified = false;
        transfer.currency = fromCard.currency;
        transfer.toCurrency = toCard.currency;
        if (!differentCurrencies) {
          transfer.toAmount = amount.amount;
        } else {
          const received = item.toAmountLiteral
            ? resolveAmount(item.toAmountLiteral, item.toAmount, toCard.currency)
            : item.toAmount > 0 ? { amount: item.toAmount, currency: toCard.currency } : null;
          if (received && Number.isFinite(received.amount) && received.amount > 0) {
            transfer.toAmount = received.amount;
            receivedAmountWasSpecified = true;
            transfer.fxRateSource = 'manual';
          } else {
            const [fromRate, toRate] = await Promise.all([
              getRateToBase(fromCard.currency, operationDate.date),
              getRateToBase(toCard.currency, operationDate.date),
            ]);
            if (fromRate && toRate) transfer.toAmount = Number((amount.amount * fromRate / toRate).toFixed(toCard.currency === 'UZS' ? 0 : 2));
            else reasons.push('FX_UNAVAILABLE');
          }
        }
        if (Number(transfer.toAmount) <= 0) reasons.push('NO_TO_AMOUNT');
        if (fromCard.currency !== 'UZS' && differentCurrencies && !receivedAmountWasSpecified) {
          const rate = await getRateToBase(fromCard.currency, operationDate.date);
          if (rate) Object.assign(transfer, { baseAmount: Math.round(amount.amount * rate), fxRate: rate, fxRateSource: 'NBU' });
          else reasons.push('FX_UNAVAILABLE');
        }
      }
      if (operationDate.reason) reasons.push(operationDate.reason);
      await sendPendingDraft({
        uid: input.uid, chatId: input.chatId, messageId: input.messageId, index: index + 1,
        operationKey, sourceText: item.rawText, operationType: kind, draft: transfer, reasons,
        amountAlternative: null, suggestion: null, catalog, language: input.language,
        isPremium: input.isPremium,
      });
      continue;
    }

    if (kind === 'debt') {
      if (!Number.isFinite(amount.amount) || amount.amount <= 0 || amount.amount > 1e15) {
        invalidAmounts.push(item.rawText);
        continue;
      }
      const reasons: DraftReason[] = [];
      const person = item.person.trim().slice(0, 120);
      if (!person) reasons.push('MISSING_PERSON');
      if (!item.debtDirection) reasons.push('AMBIGUOUS_DEBT_DIRECTION');
      if (operationDate.reason) reasons.push(operationDate.reason);
      const account = resolveCardHint(item.cardHint || item.fromCardHint, catalog.cards, 'source');
      if (item.cardHint.trim() || item.fromCardHint.trim()) {
        if (account.reason) reasons.push(account.reason);
      }
      const dueDate = resolveDueDate(item.dueDateISO, Date.now(), env.TELEGRAM_DEFAULT_TIMEZONE);
      const commission: Commission | undefined = item.commissionType && item.commissionValue > 0
        ? { type: item.commissionType, value: item.commissionValue }
        : undefined;
      const debt: Record<string, unknown> = {
        kind: 'debt', direction: item.debtDirection || 'owe_me', person, amount: amount.amount,
        currency: amount.currency, ...(commission ? { commission } : {}), ...(dueDate ? { dueDate } : {}),
        ...(account.cardId ? { accountId: account.cardId } : {}), comment: item.comment.slice(0, 200), date: operationDate.date,
      };
      if (reasons.length === 0) {
        const result = await createTelegramDebtOnce(input.uid, {
          direction: debt.direction as 'i_owe' | 'owe_me', person, amount: amount.amount,
          currency: amount.currency, commission, dueDate: dueDate ?? undefined, comment: String(debt.comment || ''), accountId: account.cardId,
          date: operationDate.date,
        }, operationKey);
        saved.push({ kind, debtId: result.debt.id, debt: result.debt, transactionId: result.transactionId });
      } else {
        await sendPendingDraft({
          uid: input.uid, chatId: input.chatId, messageId: input.messageId, index: index + 1,
          operationKey, sourceText: item.rawText, operationType: kind, draft: debt, reasons,
          amountAlternative: amount.alternative, suggestion: null, catalog, language: input.language,
          isPremium: input.isPremium,
        });
      }
      continue;
    }

    const activeDebts = catalog.debts.filter((debt) => !debt.isPaid);
    const normalizePerson = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    const personHint = normalizePerson(item.person);
    const byId = item.debtId ? activeDebts.filter((debt) => debt.id === item.debtId) : [];
    const byPerson = personHint
      ? activeDebts.filter((debt) => normalizePerson(debt.person).includes(personHint) || personHint.includes(normalizePerson(debt.person)))
      : [];
    const debtMatches = byId.length ? byId : byPerson;
    const reasons: DraftReason[] = [];
    if (debtMatches.length === 0) reasons.push('NO_DEBT_MATCH');
    if (debtMatches.length > 1) reasons.push('AMBIGUOUS_DEBT');
    if (operationDate.reason) reasons.push(operationDate.reason);
    const debt = debtMatches.length === 1 ? debtMatches[0] : undefined;
    const paymentCurrency = debt?.currency ?? item.currency;
    const paymentAmount = fullRepayment && debt
      ? Math.max(0, calcDebtTotal(debt.amount, debt.commission) - debt.paidAmount)
      : resolveAmount(item.amountLiteral, item.amount, paymentCurrency).amount;
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) invalidAmounts.push(item.rawText);
    if (debt && debt.isPaid) reasons.push('DEBT_ALREADY_PAID');
    if (debt && paymentAmount > calcDebtTotal(debt.amount, debt.commission) - debt.paidAmount) reasons.push('DEBT_PAYMENT_TOO_LARGE');
    const account = resolveCardHint(item.cardHint || item.fromCardHint, catalog.cards, 'source');
    if (item.cardHint.trim() || item.fromCardHint.trim()) {
      if (account.reason) reasons.push(account.reason);
    }
    const payment: Record<string, unknown> = {
      kind: 'debt_payment', debtId: debt?.id ?? item.debtId, person: debt?.person ?? item.person,
      direction: debt?.direction ?? item.debtDirection, amount: paymentAmount, currency: paymentCurrency,
      total: debt ? calcDebtTotal(debt.amount, debt.commission) : paymentAmount,
      paidAmount: debt?.paidAmount ?? 0, isPaid: false, accountId: account.cardId,
      comment: item.comment.slice(0, 200), date: operationDate.date,
    };
    if (reasons.length === 0 && Number.isFinite(paymentAmount) && paymentAmount > 0 && debt) {
      const result = await payTelegramDebtOnce(input.uid, {
        debtId: debt.id, amount: paymentAmount, accountId: account.cardId, date: operationDate.date,
        comment: item.comment.slice(0, 200),
      }, operationKey);
      saved.push({ kind, payment: { ...payment, ...result, accountId: account.cardId } });
    } else if (Number.isFinite(paymentAmount) && paymentAmount > 0) {
      await sendPendingDraft({
        uid: input.uid, chatId: input.chatId, messageId: input.messageId, index: index + 1,
        operationKey, sourceText: item.rawText, operationType: kind, draft: payment, reasons,
        amountAlternative: null, suggestion: null, catalog, language: input.language,
        isPremium: input.isPremium,
      });
    }
  }
  for (const operation of saved) {
    const text = operation.kind === 'transaction' && operation.transaction
      ? formatSavedTransaction(operation.transaction, catalog, input.language)
      : operation.kind === 'transfer' && operation.transaction
        ? formatSavedTransfer(operation.transaction, catalog, input.language)
        : operation.kind === 'debt' && operation.debt
          ? formatSavedDebt(operation.debt, catalog, input.language)
          : operation.payment
            ? formatSavedDebtPayment(operation.payment, catalog, input.language)
            : t(input.language, 'saved');
    const keyboard: Array<Array<Record<string, unknown>>> = [[{
      text: localized(input.language, '📱 Открыть в приложении', '📱 Ilovada ochish', '📱 Open in app'),
      web_app: { url: operation.kind === 'transaction' && operation.transactionId
        ? `${env.WEB_APP_URL}?tx=${operation.transactionId}`
        : `${env.WEB_APP_URL}?tab=${operation.kind === 'debt' || operation.kind === 'debt_payment' ? 'debts' : 'transactions'}` },
    }]];
    if (operation.kind === 'transaction' && operation.transactionId) {
      keyboard.push([{ text: localized(input.language, '✏️ Изменить', '✏️ Tahrirlash', '✏️ Edit'), callback_data: 'v1:edit:0' }]);
    }
    const sent = await sendMessage(input.chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    if (operation.transactionId) {
      await saveMessage({
        userId: input.uid, chatId: input.chatId, messageId: sent.message_id, kind: 'saved',
        items: [{ draftId: null, transactionId: operation.transactionId }],
        options: { categoryIds: catalog.categories.map((category) => category.id), cardIds: catalog.cards.map((card) => card.id), page: 0 },
      });
    }
  }
  if (invalidAmounts.length > 0) {
    const fragments = invalidAmounts.map((value) => `«${escapeHtml(value)}»`).join(', ');
    await sendMessage(input.chatId,
      input.language === 'uz'
        ? `Summani tushunmadim: ${fragments}.`
        : input.language === 'en' ? `I could not understand the amount: ${fragments}.` : `Не понял сумму: ${fragments}.`,
    );
  }
  if (blockedPremiumDebt) {
    await sendMessage(input.chatId, t(input.language, 'premium_debt_required'), {
      reply_markup: premiumKeyboard(input.language),
    });
  }
  logger.info({ uid: input.uid, updateId: input.updateId, saved: saved.length }, 'telegram.parse.completed');
}
