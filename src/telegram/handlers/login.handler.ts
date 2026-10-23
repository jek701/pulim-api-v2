import { env } from '../../config/env';
import { approveTelegramLogin } from '../../services/telegramLogin.service';
import type { TelegramUser } from '../../services/telegramAuth.service';
import { sendMessage } from '../client';
import { resolveUserContext } from '../context';
import { languageFromTelegram } from '../i18n';
import type { SupportedLanguage } from '../types';

const localized = (language: SupportedLanguage, ru: string, uz: string, en: string) =>
  language === 'uz' ? uz : language === 'en' ? en : ru;

/** https page that bounces to the app (Telegram URL buttons reject custom schemes). */
export function appReturnUrl(): string | null {
  if (env.TELEGRAM_LOGIN_RETURN_URL) return env.TELEGRAM_LOGIN_RETURN_URL;
  try {
    return new URL('/auth/telegram/app-return', new URL(env.TELEGRAM_WEBHOOK_URL).origin).toString();
  } catch {
    return null;
  }
}

const returnKeyboard = (language: SupportedLanguage) => {
  const url = appReturnUrl();
  return url
    ? {
        inline_keyboard: [[{
          text: localized(language, '📱 Вернуться в Pulim', '📱 Pulim’ga qaytish', '📱 Back to Pulim'),
          url,
        }]],
      }
    : undefined;
};

/** `/start login_<nonce>` from the native app's "Войти через Telegram" button. */
export async function handleTelegramLogin(input: {
  nonce: string;
  chatId: string;
  telegramId: string;
  telegramUser?: Record<string, unknown>;
  languageCode?: string;
}): Promise<string | null> {
  const tgUser = { ...input.telegramUser, id: input.telegramId } as TelegramUser;
  const result = await approveTelegramLogin({
    nonce: input.nonce,
    tgUser,
    chatId: input.chatId,
    defaultLanguage: languageFromTelegram(input.languageCode),
  });
  if (result.status === 'approved') {
    const context = await resolveUserContext(input.telegramId, input.chatId);
    const language = context?.language ?? languageFromTelegram(input.languageCode);
    await sendMessage(
      input.chatId,
      localized(
        language,
        '✅ Готово, вернитесь в приложение Pulim — вход завершится автоматически.',
        '✅ Tayyor, Pulim ilovasiga qayting — kirish avtomatik yakunlanadi.',
        '✅ Done, go back to the Pulim app — sign-in will finish automatically.',
      ),
      { reply_markup: returnKeyboard(language) },
    );
    return result.uid;
  }
  const context = await resolveUserContext(input.telegramId, input.chatId);
  const language = context?.language ?? result.language ?? languageFromTelegram(input.languageCode);
  await sendMessage(
    input.chatId,
    result.status === 'expired'
      ? localized(
          language,
          '⌛ Ссылка для входа устарела. Вернитесь в приложение Pulim и нажмите «Войти через Telegram» ещё раз.',
          '⌛ Kirish havolasi eskirgan. Pulim ilovasiga qayting va «Telegram orqali kirish» tugmasini yana bosing.',
          '⌛ This sign-in link has expired. Go back to the Pulim app and tap “Sign in with Telegram” again.',
        )
      : localized(
          language,
          'Эта ссылка для входа недействительна или уже использована. Начните вход заново в приложении Pulim.',
          'Bu kirish havolasi yaroqsiz yoki allaqachon ishlatilgan. Pulim ilovasida kirishni qaytadan boshlang.',
          'This sign-in link is invalid or has already been used. Start signing in again in the Pulim app.',
        ),
  );
  return context?.uid ?? null;
}
