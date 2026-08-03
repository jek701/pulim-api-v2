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
  description?: string;
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
    throw new Error(`Telegram ${method} failed: ${payload.description ?? response.status}`);
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

export function deleteMessage(chatId: string, messageId: number): Promise<boolean> {
  return callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function setMyCommands(): Promise<boolean> {
  return callTelegram('setMyCommands', {
    commands: [
      { command: 'start', description: 'Start Pulim quick entry' },
      { command: 'help', description: 'Show examples' },
      { command: 'cancel', description: 'Cancel editing' },
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
