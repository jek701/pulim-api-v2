import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleFamilyInvitePick: vi.fn(),
  handleTextMessage: vi.fn(),
}));

vi.mock('../../src/telegram/handlers/familyInvite.handler', () => ({ handleFamilyInvitePick: mocks.handleFamilyInvitePick }));
vi.mock('../../src/telegram/handlers/message.handler', () => ({ handleTextMessage: mocks.handleTextMessage }));
vi.mock('../../src/telegram/handlers/callback.handler', () => ({ handleCallbackQuery: vi.fn() }));
vi.mock('../../src/telegram/handlers/command.handler', () => ({ handleCommand: vi.fn() }));
vi.mock('../../src/telegram/handlers/media.handler', () => ({ handleReceiptPhoto: vi.fn(), handleVoiceMessage: vi.fn() }));
vi.mock('../../src/telegram/context', () => ({ resolveUserContext: vi.fn() }));
vi.mock('../../src/telegram/client', () => ({ sendMessage: vi.fn() }));

const { dispatchUpdate, telegramUpdateSchema } = await import('../../src/telegram/dispatcher');

describe('dispatchUpdate users_shared', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleFamilyInvitePick.mockResolvedValue('u1');
  });

  it('routes a contact picked in the Mini App to the family invite handler', async () => {
    const update = telegramUpdateSchema.parse({
      update_id: 1,
      message: {
        message_id: 5,
        chat: { id: 100, type: 'private' },
        from: { id: 100, language_code: 'ru' },
        users_shared: { request_id: 77, users: [{ user_id: 200, first_name: 'Malika' }] },
      },
    });

    await expect(dispatchUpdate(update)).resolves.toBe('u1');

    expect(mocks.handleFamilyInvitePick).toHaveBeenCalledWith({
      chatId: '100',
      telegramId: '100',
      requestId: 77,
      users: [{ user_id: 200, first_name: 'Malika' }],
    });
    expect(mocks.handleTextMessage).not.toHaveBeenCalled();
  });
});
