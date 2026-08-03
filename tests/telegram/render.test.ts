import { describe, expect, it } from 'vitest';
import { escapeHtml, markdownToTelegramHtml } from '../../src/telegram/render';

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
