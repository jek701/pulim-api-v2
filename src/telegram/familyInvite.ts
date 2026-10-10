import { env } from '../config/env';
import type { InlineKeyboardButton } from './client';
import { escapeHtml } from './render';
import type { SupportedLanguage } from './types';

const localized = (language: SupportedLanguage, ru: string, uz: string, en: string) =>
  language === 'uz' ? uz : language === 'en' ? en : ru;

/** Telegram start parameter carrying a household invite token (`family_<token>`). */
export const FAMILY_START_PREFIX = 'family_';

const botUsername = () => env.TELEGRAM_BOT_USERNAME.trim().replace(/^@/, '');

/** The page the Mini App opens on for an invite (used by web_app buttons in the bot chat). */
export function familyInviteWebAppUrl(token: string): string {
  const url = new URL(env.WEB_APP_URL);
  url.searchParams.set('familyInvite', token);
  return url.toString();
}

/**
 * A link that opens the bot's main Mini App straight on the invite. It works from any
 * chat, unlike web_app buttons, which Telegram allows only in the private bot chat.
 */
export function familyInviteLink(token: string): string {
  const username = botUsername();
  return username
    ? `https://t.me/${username}?startapp=${FAMILY_START_PREFIX}${token}`
    : familyInviteWebAppUrl(token);
}

export const pickButtonText = (language: SupportedLanguage) =>
  localized(language, 'Выбрать партнёра', 'Juftni tanlash', 'Choose partner');

const openInviteText = (language: SupportedLanguage) =>
  localized(language, 'Открыть приглашение', 'Taklifni ochish', 'Open invitation');

export function sharedUserName(
  user: { first_name?: string; last_name?: string; username?: string },
  language: SupportedLanguage,
): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return localized(language, 'Партнёр', 'Juftingiz', 'Partner');
}

/** Sent by the bot to a picked partner who already uses Pulim. */
export function partnerInviteMessage(
  language: SupportedLanguage,
  inviterName: string,
  householdName: string,
  token: string,
): { text: string; reply_markup: { inline_keyboard: InlineKeyboardButton[][] } } {
  const inviter = `<b>${escapeHtml(inviterName)}</b>`;
  const household = escapeHtml(householdName);
  return {
    text: localized(
      language,
      `👨‍👩‍👧 ${inviter} приглашает вас в совместный бюджет «${household}» в Pulim.\n\nВместе вы будете планировать общие расходы, а личные финансы останутся личными. Приглашение действует 7 дней.`,
      `👨‍👩‍👧 ${inviter} sizni Pulim’dagi «${household}» umumiy byudjetiga taklif qilmoqda.\n\nUmumiy xarajatlarni birga rejalashtirasiz, shaxsiy moliya esa shaxsiy qoladi. Taklif 7 kun amal qiladi.`,
      `👨‍👩‍👧 ${inviter} invites you to the shared budget “${household}” in Pulim.\n\nYou’ll plan shared spending together while personal finances stay private. The invitation is valid for 7 days.`,
    ),
    reply_markup: {
      inline_keyboard: [[{ text: openInviteText(language), web_app: { url: familyInviteWebAppUrl(token) } }]],
    },
  };
}

export const inviteDeliveredText = (language: SupportedLanguage, recipientName: string, householdName: string) => {
  const recipient = escapeHtml(recipientName);
  const household = escapeHtml(householdName);
  return localized(
    language,
    `✅ Приглашение в «${household}» отправлено: ${recipient}.`,
    `✅ «${household}» taklifi yuborildi: ${recipient}.`,
    `✅ Invitation to “${household}” sent to ${recipient}.`,
  );
};

// Deliberately neutral: never reveal whether the contact uses Pulim or blocked the bot.
export const inviteNotDeliveredText = (language: SupportedLanguage, recipientName: string) => {
  const recipient = escapeHtml(recipientName);
  return localized(
    language,
    `Не получилось отправить уведомление через бот: ${recipient}. Вернитесь в Pulim и отправьте приглашение в чат — сообщение уйдёт от вашего имени.`,
    `Bot orqali xabar yuborib bo‘lmadi: ${recipient}. Pulim’ga qayting va taklifni chatga yuboring — xabar sizning nomingizdan ketadi.`,
    `Couldn’t notify ${recipient} through the bot. Go back to Pulim and send the invitation to a chat — it will come from you.`,
  );
};

export const inviteExpiredText = (language: SupportedLanguage) =>
  localized(
    language,
    'Это приглашение уже не действует. Создайте новое в Pulim.',
    'Bu taklif endi amal qilmaydi. Pulim’da yangisini yarating.',
    'This invitation is no longer valid. Create a new one in Pulim.',
  );

/** Inline result the inviter sends from the Mini App with `WebApp.shareMessage`. */
export function inviteShareArticle(language: SupportedLanguage, householdName: string, token: string): Record<string, unknown> {
  const household = escapeHtml(householdName);
  return {
    type: 'article',
    id: `family_${token}`.slice(0, 64),
    title: localized(language, 'Приглашение в совместный бюджет', 'Umumiy byudjetga taklif', 'Shared budget invitation'),
    description: `«${householdName}» · Pulim`,
    input_message_content: {
      message_text: localized(
        language,
        `👨‍👩‍👧 Приглашаю тебя в наш совместный бюджет «${household}» в Pulim.\n\nБудем вместе планировать общие расходы, а личные финансы останутся личными.`,
        `👨‍👩‍👧 Seni Pulim’dagi «${household}» umumiy byudjetimizga taklif qilaman.\n\nUmumiy xarajatlarni birga rejalashtiramiz, shaxsiy moliya esa shaxsiy qoladi.`,
        `👨‍👩‍👧 Join our shared budget “${household}” in Pulim.\n\nWe’ll plan shared spending together while personal finances stay private.`,
      ),
      parse_mode: 'HTML',
    },
    reply_markup: {
      inline_keyboard: [[{ text: openInviteText(language), url: familyInviteLink(token) }]],
    },
  };
}
