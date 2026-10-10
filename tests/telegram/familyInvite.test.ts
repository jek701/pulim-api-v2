import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveUserContext: vi.fn(),
  sendMessage: vi.fn(),
  findTelegramUser: vi.fn(),
  getProfile: vi.fn(),
  consumeInvitePick: vi.fn(),
  recordInviteDelivery: vi.fn(),
}));

vi.mock('../../src/telegram/context', () => ({ resolveUserContext: mocks.resolveUserContext }));
vi.mock('../../src/telegram/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/telegram/client')>()),
  sendMessage: mocks.sendMessage,
}));
vi.mock('../../src/repositories/telegramUser.repository', () => ({ findTelegramUser: mocks.findTelegramUser }));
vi.mock('../../src/repositories/profile.repository', () => ({ getProfile: mocks.getProfile }));
vi.mock('../../src/services/household.service', () => ({
  consumeInvitePick: mocks.consumeInvitePick,
  recordInviteDelivery: mocks.recordInviteDelivery,
  memberName: (household: { members: { userId: string; name: string }[] }, uid: string) =>
    household.members.find((member) => member.userId === uid)?.name ?? 'Участник',
}));

const { env } = await import('../../src/config/env');
const { TelegramApiError } = await import('../../src/telegram/client');
const { familyInviteLink, inviteShareArticle, partnerInviteMessage } = await import('../../src/telegram/familyInvite');
const { handleFamilyInvitePick } = await import('../../src/telegram/handlers/familyInvite.handler');

const originalUsername = env.TELEGRAM_BOT_USERNAME;
const originalWebAppUrl = env.WEB_APP_URL;

beforeEach(() => {
  env.TELEGRAM_BOT_USERNAME = '@m_pulim_bot';
  env.WEB_APP_URL = 'https://m-pulim.uz';
});

afterEach(() => {
  env.TELEGRAM_BOT_USERNAME = originalUsername;
  env.WEB_APP_URL = originalWebAppUrl;
});

describe('family invite links', () => {
  it('opens the main Mini App via startapp and tolerates a leading @', () => {
    expect(familyInviteLink('abc_DEF-123')).toBe('https://t.me/m_pulim_bot?startapp=family_abc_DEF-123');
  });

  it('falls back to the web app when no bot username is configured', () => {
    env.TELEGRAM_BOT_USERNAME = '';
    expect(familyInviteLink('tok')).toBe('https://m-pulim.uz/?familyInvite=tok');
  });

  it('escapes names in the partner message and opens the invite in the Mini App', () => {
    const message = partnerInviteMessage('ru', '<Ikrom>', 'Дом & быт', 'tok');
    expect(message.text).toContain('&lt;Ikrom&gt;');
    expect(message.text).toContain('Дом &amp; быт');
    expect(message.reply_markup.inline_keyboard[0][0].web_app?.url).toBe('https://m-pulim.uz/?familyInvite=tok');
  });

  it('builds a shareable card with a startapp button', () => {
    const article = inviteShareArticle('uz', 'Oila', 'x'.repeat(32)) as {
      id: string;
      reply_markup: { inline_keyboard: { url: string }[][] };
    };
    expect(article.id.length).toBeLessThanOrEqual(64);
    expect(article.reply_markup.inline_keyboard[0][0].url).toContain('?startapp=family_');
  });
});

describe('handleFamilyInvitePick', () => {
  const household = { id: 'h1', name: 'Наша семья', members: [{ userId: 'u1', name: 'Ikrom' }] };
  const input = { chatId: '100', telegramId: '100', requestId: 7, users: [{ user_id: 200, first_name: 'Malika' }] };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUserContext.mockResolvedValue({ uid: 'u1', language: 'ru', profile: {} });
    mocks.consumeInvitePick.mockResolvedValue({ token: 'tok', inviterUid: 'u1', household });
    mocks.sendMessage.mockResolvedValue({ message_id: 1 });
  });

  it('notifies a partner who uses Pulim and confirms to the inviter', async () => {
    mocks.findTelegramUser.mockResolvedValue({ id: '200', data: { profileUid: 'u2', chatId: '200' } });
    mocks.getProfile.mockResolvedValue({ id: 'u2', language: 'uz' });

    await expect(handleFamilyInvitePick(input)).resolves.toBe('u1');

    expect(mocks.sendMessage).toHaveBeenCalledWith('200', expect.stringContaining('Ikrom'), expect.objectContaining({
      reply_markup: { inline_keyboard: [[expect.objectContaining({ web_app: { url: 'https://m-pulim.uz/?familyInvite=tok' } })]] },
    }));
    expect(mocks.recordInviteDelivery).toHaveBeenCalledWith('tok', { status: 'delivered', recipientName: 'Malika' });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith('100', expect.stringContaining('✅'));
  });

  it('reports not delivered, without saying why, when the contact is not a Pulim user', async () => {
    mocks.findTelegramUser.mockResolvedValue(null);

    await handleFamilyInvitePick(input);

    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith('100', expect.stringContaining('Не получилось отправить уведомление'));
    expect(mocks.recordInviteDelivery).toHaveBeenCalledWith('tok', { status: 'not_delivered', recipientName: 'Malika' });
  });

  it('treats a partner who blocked the bot as not delivered', async () => {
    mocks.findTelegramUser.mockResolvedValue({ id: '200', data: { profileUid: 'u2', chatId: '200' } });
    mocks.getProfile.mockResolvedValue({ id: 'u2', language: 'ru' });
    mocks.sendMessage.mockImplementation((chatId: string) => chatId === '200'
      ? Promise.reject(new TelegramApiError('blocked', 403, 403, 'Forbidden: bot was blocked by the user', null))
      : Promise.resolve({ message_id: 2 }));

    await handleFamilyInvitePick(input);

    expect(mocks.recordInviteDelivery).toHaveBeenCalledWith('tok', { status: 'not_delivered', recipientName: 'Malika' });
  });

  it('never sends the invite back to the inviter', async () => {
    await handleFamilyInvitePick({ ...input, users: [{ user_id: 100, first_name: 'Me' }] });

    expect(mocks.findTelegramUser).not.toHaveBeenCalled();
    expect(mocks.recordInviteDelivery).toHaveBeenCalledWith('tok', { status: 'not_delivered', recipientName: 'Me' });
  });

  it('answers a stale pick without touching any invite', async () => {
    mocks.consumeInvitePick.mockResolvedValue(null);

    await handleFamilyInvitePick(input);

    expect(mocks.recordInviteDelivery).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith('100', expect.stringContaining('не действует'));
  });
});
