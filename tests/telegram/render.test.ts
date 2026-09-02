import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  initialLanguageKeyboard,
  loginKeyboard,
  markdownToTelegramHtml,
} from '../../src/telegram/render';

describe('escapeHtml', () => {
  it('escapes all Telegram HTML control characters', () => {
    expect(escapeHtml('<b>Coffee & tea</b>')).toBe('&lt;b&gt;Coffee &amp; tea&lt;/b&gt;');
  });

  it('accepts non-string values safely', () => {
    expect(escapeHtml(45_000)).toBe('45000');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('markdownToTelegramHtml', () => {
  it('renders AI bold text and escapes untrusted HTML', () => {
    expect(markdownToTelegramHtml('Jami **479 500 UZS** va <script>')).toBe(
      'Jami <b>479 500 UZS</b> va &lt;script&gt;',
    );
  });

  it('supports headings, italic, strikethrough and code', () => {
    expect(markdownToTelegramHtml('# Natija\n*tez* ~~eski~~ `sum`')).toBe(
      '<b>Natija</b>\n<i>tez</i> <s>eski</s> <code>sum</code>',
    );
  });
});

describe('loginKeyboard', () => {
  it('keeps new Telegram sign-in and existing-account linking as separate safe paths', () => {
    const keyboard = loginKeyboard('ru').inline_keyboard;
    const telegramLogin = new URL(keyboard[0]![0]!.web_app.url);
    const existingAccount = new URL(keyboard[1]![0]!.web_app.url);
    expect(telegramLogin.searchParams.get('auth')).toBe('telegram');
    expect(telegramLogin.searchParams.get('lang')).toBe('ru');
    expect(existingAccount.searchParams.get('auth')).toBe('link');
    expect(existingAccount.searchParams.get('lang')).toBe('ru');
  });

  it('uses a dedicated callback for the initial language choice', () => {
    const buttons = initialLanguageKeyboard().inline_keyboard[0]!;
    expect(buttons.map((button) => button.callback_data)).toEqual([
      'v1:startlang:0:uz',
      'v1:startlang:0:ru',
      'v1:startlang:0:en',
    ]);
  });
});
