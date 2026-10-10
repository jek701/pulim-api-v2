import { createHash, randomBytes } from 'node:crypto';
import { db } from '../config/firebase';
import type { Card, Category, Currency } from '../domain/types';
import { getProfile } from '../repositories/profile.repository';
import { categoryDisplayName } from '../telegram/categoryAliases';
import { normalizeLanguage } from '../telegram/i18n';
import type { SupportedLanguage } from '../telegram/types';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { getIsPremium } from './entitlement.service';
import { getRateToBase } from './fxRates.service';
import { createTransaction } from './transaction.service';

/**
 * Personal keys for the iPhone Shortcut ("Команды"). The Shortcut cannot sign in
 * with Firebase, so the user creates a key in Settings and pastes it into the
 * Shortcut once. Only the SHA-256 of a key is stored; the key itself is shown once.
 * A key can do nothing but list the user's cards/expense categories and add an expense.
 */

const tokens = () => db.collection('shortcutTokens');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKEN_PREFIX = 'pulim_sc_';

export interface ShortcutTokenStatus {
  active: boolean;
  hint?: string;
  createdAt?: number;
  lastUsedAt?: number | null;
}

export async function getShortcutTokenStatus(uid: string): Promise<ShortcutTokenStatus> {
  const snap = await tokens().where('userId', '==', uid).get();
  const latest = snap.docs.map((doc) => doc.data()).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latest) return { active: false };
  return { active: true, hint: latest.hint, createdAt: latest.createdAt, lastUsedAt: latest.lastUsedAt ?? null };
}

export async function revokeShortcutTokens(uid: string): Promise<void> {
  const snap = await tokens().where('userId', '==', uid).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

/** Replaces any existing key: issuing a new one disconnects Shortcuts set up with the old one. */
export async function issueShortcutToken(uid: string): Promise<{ token: string; status: ShortcutTokenStatus }> {
  if (!(await getIsPremium(uid))) {
    throw AppError.forbidden('PREMIUM_REQUIRED', 'iPhone quick entry requires Premium.');
  }
  await revokeShortcutTokens(uid);
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  const createdAt = Date.now();
  const hint = token.slice(-4);
  await tokens().doc(hashToken(token)).create({ userId: uid, hint, createdAt, lastUsedAt: null });
  return { token, status: { active: true, hint, createdAt, lastUsedAt: null } };
}

// ── Public Shortcut API ───────────────────────────────────────────────────────

const MESSAGES = {
  invalid_key: {
    ru: '🔑 Ключ Pulim не подошёл. Откройте Pulim → Настройки → «Запись с iPhone» и создайте новый ключ.',
    uz: '🔑 Pulim kaliti mos kelmadi. Pulim → Sozlamalar → «iPhone’dan yozish» bo‘limida yangi kalit yarating.',
    en: '🔑 This Pulim key did not work. Open Pulim → Settings → “iPhone quick entry” and create a new key.',
  },
  premium: {
    ru: '💎 Запись с iPhone доступна в Premium. Откройте Pulim, чтобы оформить Premium.',
    uz: '💎 iPhone’dan yozish Premium’da mavjud. Premium olish uchun Pulim’ni oching.',
    en: '💎 iPhone quick entry is available with Premium. Open Pulim to get Premium.',
  },
  invalid_amount: {
    ru: 'Не понял сумму. Введите число, например 25000.',
    uz: 'Summani tushunmadim. Raqam kiriting, masalan 25000.',
    en: 'I could not read the amount. Enter a number, for example 25000.',
  },
  card_not_found: {
    ru: 'Карта не найдена. Запустите команду ещё раз.',
    uz: 'Karta topilmadi. Buyruqni qayta ishga tushiring.',
    en: 'Card not found. Run the shortcut again.',
  },
  category_not_found: {
    ru: 'Категория не найдена. Запустите команду ещё раз.',
    uz: 'Toifa topilmadi. Buyruqni qayta ishga tushiring.',
    en: 'Category not found. Run the shortcut again.',
  },
  fx_unavailable: {
    ru: 'Не удалось получить курс ЦБ для этой валюты. Попробуйте чуть позже.',
    uz: 'Bu valyuta uchun Markaziy bank kursini olib bo‘lmadi. Birozdan so‘ng urinib ko‘ring.',
    en: 'The central-bank rate for this currency is unavailable. Please try again later.',
  },
  no_card: { ru: '— Без карты', uz: '— Kartasiz', en: '— No card' },
  saved: { ru: '✅ Записано', uz: '✅ Yozildi', en: '✅ Saved' },
  balance: { ru: 'Остаток', uz: 'Qoldiq', en: 'Balance' },
} as const;

type MessageKey = keyof typeof MESSAGES;
const message = (language: SupportedLanguage, key: MessageKey) => MESSAGES[key][language];

/** A user-facing failure; the route sends `text` to the Shortcut as is. */
export class ShortcutError extends Error {
  constructor(readonly status: number, readonly text: string) {
    super(text);
    this.name = 'ShortcutError';
  }
}

export function languageFromHeader(value: string | undefined): SupportedLanguage {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.startsWith('uz')) return 'uz';
  if (normalized.startsWith('en')) return 'en';
  return 'ru';
}

export interface ShortcutUser {
  uid: string;
  language: SupportedLanguage;
}

export async function authenticateShortcut(
  authorization: string | undefined,
  fallbackLanguage: SupportedLanguage,
): Promise<ShortcutUser> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!token.startsWith(TOKEN_PREFIX)) throw new ShortcutError(401, message(fallbackLanguage, 'invalid_key'));
  const ref = tokens().doc(hashToken(token));
  const snap = await ref.get();
  if (!snap.exists) throw new ShortcutError(401, message(fallbackLanguage, 'invalid_key'));
  const uid = String(snap.data()!.userId);
  const profile = await getProfile(uid);
  const language = profile?.language ? normalizeLanguage(profile.language) : fallbackLanguage;
  if (!(await getIsPremium(uid))) throw new ShortcutError(402, message(language, 'premium'));
  void ref.update({ lastUsedAt: Date.now() }).catch((err: unknown) => logger.warn({ err }, 'shortcut.last_used_failed'));
  return { uid, language };
}

/** Shortcuts' "Choose from List" returns the picked label, so labels double as ids and must be unique. */
function labelled<T>(items: T[], label: (item: T) => string): Array<{ item: T; label: string }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = label(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { item, label: count === 1 ? base : `${base} (${count})` };
  });
}

async function ownedCards(uid: string): Promise<Card[]> {
  const [snap, settings] = await Promise.all([
    db.collection('cards').where('userId', '==', uid).get(),
    db.collection('userSettings').doc(uid).get(),
  ]);
  const cards = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Card)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  // Same order as the Accounts page.
  const order: string[] = Array.isArray(settings.data()?.cardOrder) ? settings.data()!.cardOrder : [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : Number.MAX_SAFE_INTEGER);
  return cards.sort((a, b) => rank(a.id) - rank(b.id));
}

async function expenseCategories(uid: string): Promise<Category[]> {
  const snap = await db.collection('categories').where('userId', '==', uid).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Category)
    .filter((category) => category.type === 'expense' || category.type === 'both')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

const cardLabel = (card: Card) => `💳 ${card.name}${card.bank ? ` · ${card.bank}` : ''}`;

async function cardOptions(user: ShortcutUser) {
  const cards = labelled(await ownedCards(user.uid), cardLabel);
  return { cards, labels: cards.length ? cards.map((entry) => entry.label) : [message(user.language, 'no_card')] };
}

async function categoryOptions(user: ShortcutUser) {
  const categories = labelled(await expenseCategories(user.uid),
    (category) => `${category.icon} ${categoryDisplayName(category, user.language)}`);
  return { categories, labels: categories.map((entry) => entry.label) };
}

export async function listShortcutCards(user: ShortcutUser): Promise<string[]> {
  return (await cardOptions(user)).labels;
}

export async function listShortcutCategories(user: ShortcutUser): Promise<string[]> {
  return (await categoryOptions(user)).labels;
}

export function parseShortcutAmount(value: unknown): number | null {
  const compact = String(value ?? '').replace(/[\s'’]/g, '');
  // iPhone locales format numbers as "25,000" or "25.000" (grouping) and "12,5" (decimal).
  const grouped = /^\d{1,3}([.,])\d{3}(\1\d{3})*$/.test(compact);
  const normalized = grouped ? compact.replace(/[.,]/g, '') : compact.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return amount > 0 && amount <= 1e15 ? amount : null;
}

function formatMoney(amount: number, currency: string, language: SupportedLanguage): string {
  const locale = language === 'uz' ? 'uz-UZ' : language === 'en' ? 'en-US' : 'ru-RU';
  const unit = currency === 'UZS' ? (language === 'uz' ? 'so‘m' : language === 'en' ? 'UZS' : 'сум') : currency;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)} ${unit}`;
}

export async function addShortcutExpense(
  user: ShortcutUser,
  body: { amount?: unknown; card?: unknown; category?: unknown },
): Promise<string> {
  const amount = parseShortcutAmount(body.amount);
  if (amount === null) throw new ShortcutError(400, message(user.language, 'invalid_amount'));

  const [{ cards }, { categories }] = await Promise.all([cardOptions(user), categoryOptions(user)]);
  const cardLabelValue = String(body.card ?? '').trim();
  const card = cards.find((entry) => entry.label === cardLabelValue)?.item;
  if (!card && cardLabelValue !== message(user.language, 'no_card')) {
    throw new ShortcutError(400, message(user.language, 'card_not_found'));
  }
  const category = categories.find((entry) => entry.label === String(body.category ?? '').trim());
  if (!category) throw new ShortcutError(400, message(user.language, 'category_not_found'));

  const currency: Currency = card?.currency ?? 'UZS';
  const date = Date.now();
  const transaction: Record<string, unknown> = {
    type: 'expense',
    amount,
    currency,
    categoryId: category.item.id,
    ...(card ? { cardId: card.id } : {}),
    comment: '',
    date,
  };
  if (currency !== 'UZS') {
    // Statistics are kept in UZS, so a foreign-currency expense needs its rate.
    const rate = await getRateToBase(currency, date);
    if (!rate) throw new ShortcutError(503, message(user.language, 'fx_unavailable'));
    Object.assign(transaction, { baseAmount: Math.round(amount * rate), fxRate: rate, fxRateSource: 'NBU' });
  }
  const saved = await createTransaction(user.uid, transaction);
  logger.info({ uid: user.uid, transactionId: saved.id }, 'shortcut.expense.created');

  const lines = [`${message(user.language, 'saved')}: ${formatMoney(amount, currency, user.language)} · ${category.label}${card ? ` · ${card.name}` : ''}`];
  if (card) {
    const fresh = await db.collection('cards').doc(card.id).get();
    const balance = Number(fresh.data()?.balance);
    if (Number.isFinite(balance) && card.cardType !== 'credit') {
      lines.push(`${message(user.language, 'balance')}: ${formatMoney(balance, currency, user.language)}`);
    }
  }
  return lines.join('\n');
}
