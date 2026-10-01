import type { SupportedLanguage } from '../telegram/types';

export function localized(language: SupportedLanguage, ru: string, uz: string, en: string): string {
  return language === 'uz' ? uz : language === 'en' ? en : ru;
}

export const notificationStrings = {
  greeting: (language: SupportedLanguage) => localized(language, '☀️ Доброе утро!', '☀️ Xayrli tong!', '☀️ Good morning!'),
  events: (language: SupportedLanguage) => localized(language, '📅 События', '📅 Voqealar', '📅 Events'),
  weekly: (language: SupportedLanguage) => localized(language, '📊 Неделя', '📊 Hafta', '📊 Week'),
  monthly: (language: SupportedLanguage) => localized(language, '📈 Итоги', '📈 Yakunlar', '📈 Summary'),
  open: (language: SupportedLanguage) => localized(language, '📱 Открыть Pulim', '📱 Pulim’ni ochish', '📱 Open Pulim'),
  disable: (language: SupportedLanguage) => localized(language, '🔕 Отключить', '🔕 O‘chirish', '🔕 Disable'),
  premium: () => '💎 Premium',
};
