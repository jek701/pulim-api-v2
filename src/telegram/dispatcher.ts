import { z } from 'zod';
import { logger } from '../utils/logger';
import { sendMessage } from './client';
import { handleCallbackQuery } from './handlers/callback.handler';
import { handleCommand } from './handlers/command.handler';
import { handleTextMessage } from './handlers/message.handler';
import { t } from './i18n';
import { resolveUserContext } from './context';

const userSchema = z.object({ id: z.union([z.number(), z.string()]) }).passthrough();
const chatSchema = z.object({ id: z.union([z.number(), z.string()]), type: z.string() }).passthrough();
const messageSchema = z.object({
  message_id: z.number(),
  chat: chatSchema,
  from: userSchema.optional(),
  text: z.string().optional(),
  voice: z.unknown().optional(),
  photo: z.unknown().optional(),
  document: z.unknown().optional(),
  audio: z.unknown().optional(),
}).passthrough();

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: z.object({
    id: z.string(),
    from: userSchema,
    data: z.string().optional(),
    message: messageSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export async function dispatchUpdate(update: TelegramUpdate): Promise<string | null> {
  const callback = update.callback_query;
  if (callback?.message && callback.data) return handleCallbackQuery({
    id: callback.id,
    data: callback.data,
    chatId: String(callback.message.chat.id),
    messageId: callback.message.message_id,
    telegramId: String(callback.from.id),
  });

  const message = update.message;
  if (!message || message.chat.type !== 'private' || !message.from) return null;
  const chatId = String(message.chat.id);
  const telegramId = String(message.from.id);
  if (message.text?.startsWith('/')) {
    const command = message.text.split(/\s/, 1)[0]!.split('@', 1)[0]!.toLowerCase();
    return handleCommand({ command, chatId, telegramId });
  }
  if (message.text) {
    return handleTextMessage({
      updateId: update.update_id,
      messageId: message.message_id,
      chatId,
      telegramId,
      text: message.text,
    });
  }
  if (message.voice || message.photo || message.document || message.audio) {
    const context = await resolveUserContext(telegramId, chatId);
    await sendMessage(chatId, t(context?.language ?? 'uz', 'unsupported'));
    return context?.uid ?? null;
  }
  logger.debug({ updateId: update.update_id }, 'telegram.update.ignored');
  return null;
}
