import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { sendMessage, sendMessageDraft, setWebhook, TelegramApiError } from '../../src/telegram/client';

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

describe('TelegramApiError', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves status, Telegram error code, description, and retry_after', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({
        ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 },
      }),
    }));
    const error = await sendMessage('42', 'hello').catch((reason) => reason);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ status: 429, errorCode: 429, retryAfter: 7, description: 'Too Many Requests' });
  });
});

describe('downloadFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never puts the bot token into the error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const { downloadFile } = await import('../../src/telegram/client');

    const error = await downloadFile('voice/file_1.oga', 1024).catch((reason: unknown) => reason as Error);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.message).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it('rejects files above the size limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)),
    }));
    const { downloadFile } = await import('../../src/telegram/client');

    await expect(downloadFile('voice/file_1.oga', 1024)).rejects.toThrow('larger than');
  });
});
