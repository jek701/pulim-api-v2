import { env } from '../config/env';
import type { SupportedLanguage } from './types';

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

export const premiumKeyboard = (language: SupportedLanguage) => ({
  inline_keyboard: [[
    {
      text: '💎 Premium',
      web_app: { url: env.PREMIUM_CHECKOUT_URL || `${env.WEB_APP_URL}?upgrade=1` },
    },
    {
      text: language === 'uz' ? '📱 Pulim' : language === 'en' ? '📱 Pulim' : '📱 Pulim',
      web_app: { url: env.WEB_APP_URL },
    },
  ]],
});
