import type { SupportedLanguage } from '../telegram/types';
import { escapeHtml } from '../telegram/render';

const locale = (language: SupportedLanguage) => language === 'uz' ? 'uz-UZ' : language === 'en' ? 'en-GB' : 'ru-RU';

export function formatNumber(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits })
    .format(value)
    .replace(/[\s\u00a0\u202f]/g, '\u00a0');
}

export function currencyLabel(currency: string, language: SupportedLanguage): string {
  if (currency !== 'UZS') return currency;
  return language === 'uz' ? 'so‘m' : language === 'en' ? 'UZS' : 'сум';
}

export function formatMoney(amount: number, currency: string, language: SupportedLanguage): string {
  return `${formatNumber(amount, Number.isInteger(amount) ? 0 : 2)} ${currencyLabel(currency, language)}`;
}

export function formatDate(timestamp: number, language: SupportedLanguage, timeZone: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale(language), {
    timeZone,
    day: 'numeric',
    month: 'long',
    ...options,
  }).format(new Date(timestamp));
}

export function formatMonth(timestamp: number, language: SupportedLanguage, timeZone: string): string {
  return new Intl.DateTimeFormat(locale(language), { timeZone, month: 'long', year: 'numeric' })
    .format(new Date(timestamp));
}

export function formatDateRange(from: number, to: number, language: SupportedLanguage, timeZone: string): string {
  return `${formatDate(from, language, timeZone)} — ${formatDate(to, language, timeZone)}`;
}

export function safe(value: unknown, limit = 160): string {
  const text = String(value ?? '');
  return escapeHtml(text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
}

export function pluralDays(value: number, language: SupportedLanguage): string {
  if (language === 'en') return `${value} ${value === 1 ? 'day' : 'days'}`;
  if (language === 'uz') return `${value} kun`;
  const mod10 = value % 10;
  const mod100 = value % 100;
  const noun = mod10 === 1 && mod100 !== 11 ? 'день'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'дня' : 'дней';
  return `${value} ${noun}`;
}
