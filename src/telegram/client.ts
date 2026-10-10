import { env } from '../config/env';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: number | null,
    readonly description: string,
    readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
}

async function callTelegram<T>(
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json() as TelegramResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    const description = payload.description ?? `HTTP ${response.status}`;
    throw new TelegramApiError(
      `Telegram ${method} failed: ${description}`,
      response.status,
      payload.error_code ?? null,
      description,
      payload.parameters?.retry_after ?? null,
    );
  }
  return payload.result;
}

export function sendMessage(
  chatId: string,
  text: string,
  options: Record<string, unknown> = {},
): Promise<TelegramMessage> {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

export function editMessageText(
  chatId: string,
  messageId: number,
  text: string,
  options: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<TelegramMessage> {
  return callTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  }, signal);
}

export interface KeyboardButtonRequestUsers {
  request_id: number;
  user_is_bot?: boolean;
  max_quantity?: number;
  request_name?: boolean;
  request_username?: boolean;
}

/**
 * Stores a request_users button that the Mini App opens with `WebApp.requestChat`
 * (Bot API 9.6). The picked users reach the bot as a `users_shared` message.
 */
export function savePreparedKeyboardButton(
  userId: number,
  button: { text: string; request_users: KeyboardButtonRequestUsers },
): Promise<{ id: string }> {
  return callTelegram('savePreparedKeyboardButton', { user_id: userId, button });
}

/** Stores a message the Mini App user can send to a chat with `WebApp.shareMessage` (Bot API 8.0). */
export function savePreparedInlineMessage(
  userId: number,
  result: Record<string, unknown>,
  options: { allow_user_chats?: boolean; allow_group_chats?: boolean } = {},
): Promise<{ id: string; expiration_date: number }> {
  return callTelegram('savePreparedInlineMessage', { user_id: userId, result, ...options });
}

export function answerCallbackQuery(id: string, text?: string): Promise<boolean> {
  return callTelegram('answerCallbackQuery', {
    callback_query_id: id,
    ...(text ? { text } : {}),
  });
}

export function sendChatAction(chatId: string, action = 'typing'): Promise<boolean> {
  return callTelegram('sendChatAction', { chat_id: chatId, action });
}

/** Streams an ephemeral private-chat preview. The final answer must still use sendMessage. */
export function sendMessageDraft(
  chatId: string,
  draftId: number,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return callTelegram('sendMessageDraft', {
    chat_id: Number(chatId),
    draft_id: draftId,
    text,
    parse_mode: 'HTML',
  }, signal);
}

export interface TelegramFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

export function getFile(fileId: string): Promise<TelegramFile> {
  return callTelegram('getFile', { file_id: fileId });
}

/** Downloads a file returned by getFile. The URL embeds the bot token, so it never appears in errors. */
export async function downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const description = `HTTP ${response.status}`;
    throw new TelegramApiError(`Telegram file download failed: ${description}`, response.status, null, description, null);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`Telegram file is larger than ${maxBytes} bytes.`);
  return buffer;
}

export function deleteMessage(chatId: string, messageId: number): Promise<boolean> {
  return callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function setMyCommands(): Promise<boolean> {
  return callTelegram('setMyCommands', {
    commands: [
      { command: 'start', description: 'Start Pulim quick entry' },
      { command: 'help', description: 'Show examples' },
      { command: 'language', description: 'Change reply language' },
      { command: 'cancel', description: 'Cancel editing' },
      { command: 'stop', description: 'Disable Pulim reminders' },
    ],
  });
}

export function setWebhook(): Promise<boolean> {
  return callTelegram('setWebhook', {
    url: env.TELEGRAM_WEBHOOK_URL,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    // Never discard messages which arrived while the API was unavailable.
    drop_pending_updates: false,
  });
}
