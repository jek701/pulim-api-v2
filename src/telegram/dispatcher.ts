import { z } from 'zod';
import { logger } from '../utils/logger';
import { sendMessage } from './client';
import { handleCallbackQuery } from './handlers/callback.handler';
import { handleCommand } from './handlers/command.handler';
import { handleFamilyInvitePick } from './handlers/familyInvite.handler';
import { handleReceiptPhoto, handleVoiceMessage } from './handlers/media.handler';
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
const photoSchema = z.array(z.object({ file_id: z.string(), width: z.number(), height: z.number() }).passthrough()).min(1);
const usersSharedSchema = z.object({
  request_id: z.number().int(),
  users: z.array(z.object({
    user_id: z.union([z.number(), z.string()]),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  }).passthrough()).min(1),
}).passthrough();
const imageDocumentSchema = z.object({ file_id: z.string(), mime_type: z.string().regex(/^image\/(jpeg|png|webp)$/) }).passthrough();

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
  // A contact picked in the Mini App's family invite flow (WebApp.requestChat).
  const usersShared = usersSharedSchema.safeParse(message.users_shared);
  if (usersShared.success) {
    return handleFamilyInvitePick({
      chatId,
      telegramId,
      requestId: usersShared.data.request_id,
      users: usersShared.data.users,
    });
  }
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
  // Telegram lists photo sizes smallest first; the largest reads best. Receipts sent
  // "as a file" arrive as an image document instead.
  const photo = photoSchema.safeParse(message.photo);
  const imageDocument = imageDocumentSchema.safeParse(message.document);
  if (photo.success || imageDocument.success) {
    return handleReceiptPhoto({
      updateId: update.update_id,
      messageId: message.message_id,
      chatId,
      telegramId,
      languageCode: message.from.language_code,
      fileId: photo.success ? photo.data[photo.data.length - 1]!.file_id : imageDocument.data!.file_id,
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
