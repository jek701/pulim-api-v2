import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { sendMessageDraft, setWebhook } from '../../src/telegram/client';

describe('setWebhook', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('registers the configured endpoint without dropping pending updates', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(setWebhook()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/setWebhook');
    expect(JSON.parse(String(options.body))).toEqual({
      url: env.TELEGRAM_WEBHOOK_URL,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  });
});

describe('sendMessageDraft', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses one draft id and Telegram HTML formatting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendMessageDraft('42', 123, '<b>Partial</b>');

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({
      chat_id: 42,
      draft_id: 123,
      text: '<b>Partial</b>',
      parse_mode: 'HTML',
    });
  });
});
