import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveUserContext: vi.fn(),
  getIsPremium: vi.fn(),
  sendMessage: vi.fn(),
  sendChatAction: vi.fn(),
  transcribeVoice: vi.fn(),
  consumeParse: vi.fn(),
  refundParse: vi.fn(),
  handleTextMessage: vi.fn(),
}));

vi.mock('../../src/telegram/context', () => ({ resolveUserContext: mocks.resolveUserContext }));
vi.mock('../../src/services/entitlement.service', () => ({ getIsPremium: mocks.getIsPremium }));
vi.mock('../../src/telegram/client', () => ({ sendMessage: mocks.sendMessage, sendChatAction: mocks.sendChatAction }));
vi.mock('../../src/telegram/media.service', () => ({ transcribeVoice: mocks.transcribeVoice }));
vi.mock('../../src/telegram/usage.repository', () => ({ consumeParse: mocks.consumeParse, refundParse: mocks.refundParse }));
vi.mock('../../src/telegram/handlers/message.handler', () => ({ handleTextMessage: mocks.handleTextMessage }));

const { handleVoiceMessage } = await import('../../src/telegram/handlers/media.handler');

const voice = {
  updateId: 7, messageId: 11, chatId: '42', telegramId: '42', fileId: 'file', duration: 5,
};

describe('handleVoiceMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUserContext.mockResolvedValue({ uid: 'u1', language: 'ru', profile: {} });
    mocks.sendMessage.mockResolvedValue({ message_id: 1 });
    mocks.sendChatAction.mockResolvedValue(true);
    mocks.consumeParse.mockResolvedValue(null);
    mocks.handleTextMessage.mockResolvedValue('u1');
  });

  it('offers Premium instead of transcribing for free users', async () => {
    mocks.getIsPremium.mockResolvedValue(false);

    await expect(handleVoiceMessage(voice)).resolves.toBe('u1');

    expect(mocks.transcribeVoice).not.toHaveBeenCalled();
    expect(mocks.consumeParse).not.toHaveBeenCalled();
    const [, text, options] = mocks.sendMessage.mock.calls[0]!;
    expect(text).toContain('Premium');
    expect(JSON.stringify(options.reply_markup)).toContain('Premium');
  });

  it('feeds the transcript into the text pipeline for Premium users', async () => {
    mocks.getIsPremium.mockResolvedValue(true);
    mocks.transcribeVoice.mockResolvedValue('такси 25 тысяч');

    await handleVoiceMessage(voice);

    expect(mocks.consumeParse).toHaveBeenCalledWith('u1', '7', true);
    expect(mocks.handleTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'такси 25 тысяч', updateId: 7 }));
  });

  it('refunds the quota when nothing was recognised', async () => {
    mocks.getIsPremium.mockResolvedValue(true);
    mocks.transcribeVoice.mockRejectedValue(new Error('boom'));

    await handleVoiceMessage(voice);

    expect(mocks.refundParse).toHaveBeenCalledWith('u1', '7');
    expect(mocks.handleTextMessage).not.toHaveBeenCalled();
  });

  it('rejects voice notes over the length limit before spending anything', async () => {
    mocks.getIsPremium.mockResolvedValue(true);

    await handleVoiceMessage({ ...voice, duration: 600 });

    expect(mocks.consumeParse).not.toHaveBeenCalled();
    expect(mocks.transcribeVoice).not.toHaveBeenCalled();
  });
});
