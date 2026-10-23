import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({ tables: new Map<string, Map<string, Row>>() }));
const mocks = vi.hoisted(() => ({
  signInTelegramUser: vi.fn(),
  createCustomToken: vi.fn(),
  sendMessage: vi.fn(),
  resolveUserContext: vi.fn(),
  setNotificationsEnabled: vi.fn(),
}));

vi.mock('../../src/db/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/documents')>();
  const rowsFor = (table: string) => {
    if (!store.tables.has(table)) store.tables.set(table, new Map());
    return store.tables.get(table)!;
  };
  const read = async (key: { table: string; id: string }) => {
    const data = rowsFor(key.table).get(key.id);
    return { id: key.id, key, exists: !!data, data: data ? structuredClone(data) : undefined };
  };
  return {
    ...actual,
    readDocument: read,
    insertDocument: async (key: { table: string; id: string }, data: Row) => {
      if (rowsFor(key.table).has(key.id)) throw new Error('Record already exists');
      rowsFor(key.table).set(key.id, structuredClone(data));
    },
    runSqlTransaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const writes: Array<() => void> = [];
      const result = await work({
        read,
        save: (key: { table: string; id: string }, data: Row, options?: { merge?: boolean }) =>
          writes.push(() => {
            const rows = rowsFor(key.table);
            rows.set(key.id, { ...(options?.merge ? rows.get(key.id) : {}), ...structuredClone(data) });
          }),
      });
      writes.forEach((write) => write());
      return result;
    },
  };
});
vi.mock('../../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      TELEGRAM_BOT_USERNAME: 'pulim_test_bot',
      TELEGRAM_WEBHOOK_URL: 'https://api.example.test/telegram/webhook',
      TELEGRAM_LOGIN_RETURN_URL: '',
    },
  };
});
vi.mock('../../src/services/telegramAuth.service', () => ({ signInTelegramUser: mocks.signInTelegramUser }));
vi.mock('../../src/config/firebaseAuth', () => ({ auth: { createCustomToken: mocks.createCustomToken } }));
vi.mock('../../src/telegram/client', () => ({ sendMessage: mocks.sendMessage }));
vi.mock('../../src/telegram/context', () => ({ resolveUserContext: mocks.resolveUserContext }));
vi.mock('../../src/notifications/settings', () => ({ setNotificationsEnabled: mocks.setNotificationsEnabled }));

const { createTelegramLoginRequest, exchangeTelegramLogin } = await import('../../src/services/telegramLogin.service');
const { handleCommand } = await import('../../src/telegram/handlers/command.handler');

const CLAIMS = { provider: 'telegram', telegramId: '100', telegramUsername: 'ali' };
const telegramUser = { id: 100, is_bot: false, first_name: 'Ali', username: 'ali', language_code: 'ru' };

const nonceOf = (deepLink: string) => new URL(deepLink).searchParams.get('start')!.replace(/^login_/, '');
const startLogin = (nonce: string, telegramId = '100') =>
  handleCommand({
    command: '/start',
    argument: `login_${nonce}`,
    rawArgument: `login_${nonce}`,
    chatId: telegramId,
    telegramId,
    languageCode: 'ru',
    telegramUser: { ...telegramUser, id: Number(telegramId) },
  });
const lastReply = () => mocks.sendMessage.mock.calls.at(-1) as [string, string, Record<string, any>?];
const appError = (code: string, statusCode: number) => expect.objectContaining({ code, statusCode });

describe('Telegram bot deep-link login', () => {
  beforeEach(() => {
    store.tables.clear();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-24T10:00:00Z') });
    mocks.signInTelegramUser.mockResolvedValue({ uid: 'tg_100', telegramId: '100', isNewUser: false, claims: CLAIMS });
    mocks.createCustomToken.mockResolvedValue('custom-token');
    mocks.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 100, type: 'private' } });
    mocks.resolveUserContext.mockResolvedValue({ uid: 'tg_100', profile: { id: 'tg_100' }, language: 'ru' });
  });
  afterEach(() => vi.useRealTimers());

  it('creates a 5-minute request with a bot deep link and stores only hashes', async () => {
    const request = await createTelegramLoginRequest({ language: 'ru' });

    expect(request.deepLink).toMatch(/^https:\/\/t\.me\/pulim_test_bot\?start=login_[A-Za-z0-9_-]{32}$/);
    expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.expiresAt).toBe('2026-10-24T10:05:00.000Z');
    const stored = JSON.stringify([...store.tables.get('telegramLoginRequests')!]);
    expect(stored).not.toContain(nonceOf(request.deepLink));
    expect(stored).not.toContain(request.deviceSecret);
    await expect(exchangeTelegramLogin(request.requestId, request.deviceSecret)).resolves.toEqual({
      status: 'pending',
      expiresAt: request.expiresAt,
    });
  });

  it('approves through /start login_<nonce> and hands out the token exactly once', async () => {
    const request = await createTelegramLoginRequest({ language: 'ru' });

    await expect(startLogin(nonceOf(request.deepLink))).resolves.toBe('tg_100');

    expect(mocks.signInTelegramUser).toHaveBeenCalledWith({
      tgUser: expect.objectContaining({ id: '100', username: 'ali', first_name: 'Ali' }),
      chatId: '100',
      defaultLanguage: 'ru',
    });
    const [chatId, text, options] = lastReply();
    expect(chatId).toBe('100');
    expect(text).toContain('Готово, вернитесь в приложение');
    expect(options?.reply_markup.inline_keyboard[0][0].url).toBe('https://api.example.test/auth/telegram/app-return');

    await expect(exchangeTelegramLogin(request.requestId, request.deviceSecret)).resolves.toEqual({
      status: 'approved',
      customToken: 'custom-token',
      uid: 'tg_100',
      isNewUser: false,
    });
    expect(mocks.createCustomToken).toHaveBeenCalledWith('tg_100', CLAIMS);
    await expect(exchangeTelegramLogin(request.requestId, request.deviceSecret)).rejects.toEqual(
      appError('LOGIN_REQUEST_USED', 410),
    );
  });

  it('gives the app a fresh window after a late approval', async () => {
    const request = await createTelegramLoginRequest({});
    vi.setSystemTime(new Date('2026-10-24T10:04:30Z'));
    await startLogin(nonceOf(request.deepLink));
    vi.setSystemTime(new Date('2026-10-24T10:06:00Z'));

    await expect(exchangeTelegramLogin(request.requestId, request.deviceSecret)).resolves.toMatchObject({
      status: 'approved',
    });
  });

  it('rejects an expired request in the bot and at the exchange', async () => {
    const request = await createTelegramLoginRequest({ language: 'uz' });
    vi.setSystemTime(new Date('2026-10-24T10:05:01Z'));
    mocks.resolveUserContext.mockResolvedValue(null);

    await expect(startLogin(nonceOf(request.deepLink))).resolves.toBeNull();

    expect(mocks.signInTelegramUser).not.toHaveBeenCalled();
    expect(lastReply()[1]).toContain('Kirish havolasi eskirgan');
    await expect(exchangeTelegramLogin(request.requestId, request.deviceSecret)).rejects.toEqual(
      appError('LOGIN_REQUEST_EXPIRED', 410),
    );
  });

  it('expires an approved request the app never picked up', async () => {
    const request = await createTelegramLoginRequest({});
    await startLogin(nonceOf(request.deepLink));
    vi.setSystemTime(new Date('2026-10-24T10:05:01Z'));

    await expect(exchangeTelegramLogin(request.requestId, request.deviceSecret)).rejects.toEqual(
      appError('LOGIN_REQUEST_EXPIRED', 410),
    );
    expect(mocks.createCustomToken).not.toHaveBeenCalled();
  });

  it('rejects a wrong device secret with 401, before revealing the status', async () => {
    const request = await createTelegramLoginRequest({});
    await startLogin(nonceOf(request.deepLink));

    await expect(exchangeTelegramLogin(request.requestId, 'not-the-secret')).rejects.toEqual(
      appError('LOGIN_REQUEST_SECRET_INVALID', 401),
    );
    expect(mocks.createCustomToken).not.toHaveBeenCalled();
    await expect(exchangeTelegramLogin(request.requestId, request.deviceSecret)).resolves.toMatchObject({
      status: 'approved',
    });
  });

  it('returns 404 for an unknown request id', async () => {
    await expect(exchangeTelegramLogin('x'.repeat(43), 'secret')).rejects.toEqual(
      appError('LOGIN_REQUEST_NOT_FOUND', 404),
    );
  });

  it('answers an unknown or malformed nonce with a clear message', async () => {
    for (const nonce of ['A'.repeat(32), 'short', '']) {
      await startLogin(nonce);
      expect(lastReply()[1]).toContain('недействительна или уже использована');
    }
    expect(mocks.signInTelegramUser).not.toHaveBeenCalled();
  });

  it('does not let a second Telegram account reuse an approved link', async () => {
    const request = await createTelegramLoginRequest({});
    const nonce = nonceOf(request.deepLink);
    await startLogin(nonce);

    await startLogin(nonce, '200');
    expect(lastReply()[1]).toContain('недействительна или уже использована');

    // The original user tapping again (or a webhook retry) is still fine.
    await startLogin(nonce);
    expect(lastReply()[1]).toContain('Готово');
    expect(mocks.signInTelegramUser).toHaveBeenCalledTimes(1);
  });
});

describe('existing /start payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 100, type: 'private' } });
    mocks.resolveUserContext.mockResolvedValue({ uid: 'tg_100', profile: { id: 'tg_100' }, language: 'ru' });
  });

  it('keeps plain /start as the welcome message', async () => {
    await expect(handleCommand({ command: '/start', argument: '', chatId: '100', telegramId: '100' })).resolves.toBe('tg_100');
    expect(lastReply()[1]).toContain('Добро пожаловать в Pulim');
    expect(mocks.signInTelegramUser).not.toHaveBeenCalled();
  });

  it('keeps /start notify enabling reminders', async () => {
    await handleCommand({ command: '/start', argument: 'notify', chatId: '100', telegramId: '100' });
    expect(mocks.setNotificationsEnabled).toHaveBeenCalledWith('tg_100', true);
    expect(mocks.signInTelegramUser).not.toHaveBeenCalled();
  });

  it('keeps the language prompt for unknown users, including a family_ payload', async () => {
    mocks.resolveUserContext.mockResolvedValue(null);
    for (const argument of ['', 'family_abc123']) {
      await handleCommand({ command: '/start', argument, chatId: '300', telegramId: '300', languageCode: 'ru' });
      expect(lastReply()[1]).toContain('Tilni tanlang');
    }
    expect(mocks.signInTelegramUser).not.toHaveBeenCalled();
  });
});
