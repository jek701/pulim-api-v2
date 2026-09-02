import { env } from '../config/env';
import type { SupportedLanguage } from './types';

function webAppUrl(params: Record<string, string> = {}): string {
  const url = new URL(env.WEB_APP_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  })[character]!);
}

/** Convert the small Markdown subset used by Pulim AI into safe Telegram HTML. */
export function markdownToTelegramHtml(value: unknown): string {
  const source = String(value ?? '');
  const protectedCode: string[] = [];
  const protect = (html: string) => {
    const marker = `\uE000${protectedCode.length}\uE001`;
    protectedCode.push(html);
    return marker;
  };

  let output = source
    .replace(/```(?:[a-z0-9_-]+)?\n?([\s\S]*?)```/gi, (_match, code: string) =>
      protect(`<pre>${escapeHtml(code.trimEnd())}</pre>`))
    .replace(/`([^`\n]+)`/g, (_match, code: string) => protect(`<code>${escapeHtml(code)}</code>`));

  output = escapeHtml(output)
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');

  return output.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => protectedCode[Number(index)] ?? '');
}

export const openAppKeyboard = (language: SupportedLanguage) => ({
  inline_keyboard: [[{
    text: language === 'uz' ? '📱 Pulim’ni ochish' : language === 'en' ? '📱 Open Pulim' : '📱 Открыть Pulim',
    web_app: { url: env.WEB_APP_URL },
  }]],
});

export const loginKeyboard = (language: SupportedLanguage) => ({
  inline_keyboard: [
    [{
      text: language === 'uz'
        ? '⚡ Telegram orqali kirish'
        : language === 'en'
          ? '⚡ Sign in with Telegram'
          : '⚡ Войти через Telegram',
      web_app: { url: webAppUrl({ auth: 'telegram', lang: language }) },
    }],
    [{
      text: language === 'uz'
        ? '🔗 Pulim hisobim bor'
        : language === 'en'
          ? '🔗 I already have a Pulim account'
          : '🔗 У меня уже есть аккаунт Pulim',
      web_app: { url: webAppUrl({ auth: 'link', lang: language }) },
    }],
  ],
});

export const languageKeyboard = () => ({
  inline_keyboard: [[
    { text: '🇺🇿 O‘zbekcha', callback_data: 'v1:lang:0:uz' },
    { text: '🇷🇺 Русский', callback_data: 'v1:lang:0:ru' },
    { text: '🇬🇧 English', callback_data: 'v1:lang:0:en' },
  ]],
});

export const initialLanguageKeyboard = () => ({
  inline_keyboard: [[
    { text: '🇺🇿 O‘zbekcha', callback_data: 'v1:startlang:0:uz' },
    { text: '🇷🇺 Русский', callback_data: 'v1:startlang:0:ru' },
    { text: '🇬🇧 English', callback_data: 'v1:startlang:0:en' },
  ]],
});

export const welcomeKeyboard = (language: SupportedLanguage) => ({
  inline_keyboard: [
    [{
      text: language === 'uz' ? '📱 Pulim’ni ochish' : language === 'en' ? '📱 Open Pulim' : '📱 Открыть Pulim',
      web_app: { url: env.WEB_APP_URL },
    }],
    [{ text: language === 'uz' ? '🌐 Tilni o‘zgartirish' : language === 'en' ? '🌐 Change language' : '🌐 Изменить язык', callback_data: 'v1:langmenu:0' }],
  ],
});

export const premiumKeyboard = (language: SupportedLanguage) => ({
  inline_keyboard: [[
    {
      text: '💎 Premium',
      web_app: { url: env.PREMIUM_CHECKOUT_URL || webAppUrl({ upgrade: '1' }) },
    },
    {
      text: language === 'uz' ? '📱 Pulim' : language === 'en' ? '📱 Pulim' : '📱 Pulim',
      web_app: { url: env.WEB_APP_URL },
    },
  ]],
});
