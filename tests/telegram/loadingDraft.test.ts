import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectMessageLanguage,
  loadingPhrases,
  startBudgetLoadingMessage,
} from '../../src/telegram/loadingDraft.service';

describe('Telegram budget loading draft', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the current message language when it can be detected', () => {
    expect(detectMessageLanguage('Какие расходы были в июле?', 'en')).toBe('ru');
    expect(detectMessageLanguage('Bugun qancha pul sarfladim?', 'en')).toBe('uz');
    expect(detectMessageLanguage('Бугун қанча пул сарфладим?', 'ru')).toBe('uz');
    expect(detectMessageLanguage('How much did I spend today?', 'uz')).toBe('en');
  });

  it('falls back to the app language for language-neutral input', () => {
    expect(detectMessageLanguage('07.2026?', 'uz')).toBe('uz');
  });

  it('provides several localized phrases to rotate', () => {
    expect(loadingPhrases('ru').length).toBeGreaterThan(2);
    expect(loadingPhrases('uz').join(' ')).toContain('so‘m');
    expect(loadingPhrases('en').join(' ')).toContain('budget');
  });

  it('immediately sends a real reply to the user message', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: { message_id: 91, chat: { id: 42, type: 'private' } },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const loading = await startBudgetLoadingMessage({
      chatId: '42',
      replyToMessageId: 77,
      language: 'ru',
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sendMessage');
    expect(JSON.parse(String(options.body))).toMatchObject({
      chat_id: '42',
      text: '🧮',
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    });
    await loading.stop();
  });
});
