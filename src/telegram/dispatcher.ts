import { z } from 'zod';
import { logger } from '../utils/logger';
import { sendMessage } from './client';
import { handleCallbackQuery } from './handlers/callback.handler';
import { handleCommand } from './handlers/command.handler';
import { handleVoiceMessage } from './handlers/media.handler';
import { handleTextMessage } from './handlers/message.handler';
import { t } from './i18n';
import { resolveUserContext } from './context';

const userSchema = z.object({
  id: z.union([z.number(), z.string()]),
  language_code: z.string().optional(),
}).passthrough();
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

const voiceSchema = z.object({ file_id: z.string(), duration: z.number() }).passthrough();

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
    const text = message.text.trim();
    const [rawCommand = '', ...parts] = text.split(/\s+/);
    const command = rawCommand.split('@', 1)[0]!.toLowerCase();
    return handleCommand({
      command,
      argument: parts.join(' ').trim(),
      rawArgument: text.slice(rawCommand.length).trim(),
      chatId,
      telegramId,
      languageCode: message.from.language_code,
    });
  }
  if (message.text) {
    return handleTextMessage({
      updateId: update.update_id,
      messageId: message.message_id,
      chatId,
      telegramId,
      languageCode: message.from.language_code,
      text: message.text,
    });
  }
  const voice = voiceSchema.safeParse(message.voice);
  if (voice.success) {
    return handleVoiceMessage({
      updateId: update.update_id,
      messageId: message.message_id,
      chatId,
      telegramId,
      languageCode: message.from.language_code,
      fileId: voice.data.file_id,
      duration: voice.data.duration,
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
