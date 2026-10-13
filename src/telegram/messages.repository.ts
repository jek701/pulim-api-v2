import {
  Timestamp,
  documentKey,
  queryTable,
  readDocument,
  runSqlTransaction,
  saveDocument,
} from '../db/documents';
import type { NotificationPayload } from '../notifications/types';
export interface TelegramMessageContext {
  userId: string;
  chatId: string;
  messageId: number;
  kind: 'saved' | 'draft' | 'summary' | 'edit' | 'notification';
  items: Array<{
    draftId: string | null;
    transactionId: string | null;
    subscriptionId?: string;
    debtId?: string;
    expectedNextBillingDate?: number;
  }>;
  options: {
    categoryIds: string[];
    cardIds: string[];
    page: number;
  } | null;
  notification?: {
    payload: NotificationPayload;
    introIncluded: boolean;
    completedActions: number[];
  };
}
const id = (chatId: string, messageId: number) => `${chatId}_${messageId}`;
export async function saveMessage(context: TelegramMessageContext): Promise<void> {
  await saveDocument(
    documentKey(queryTable('telegramMessages'), id(context.chatId, context.messageId)),
    {
      ...context,
      createdAt: Date.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86400000),
    },
  );
}
export async function getMessage(
  chatId: string,
  messageId: number,
): Promise<TelegramMessageContext | null> {
  const snap = await readDocument(
    documentKey(queryTable('telegramMessages'), id(chatId, messageId)),
  );
  return snap.exists ? (snap.data as TelegramMessageContext) : null;
}
export async function updateMessageOptions(
  chatId: string,
  messageId: number,
  options: TelegramMessageContext['options'],
): Promise<void> {
  await saveDocument(
    documentKey(queryTable('telegramMessages'), id(chatId, messageId)),
    { options },
    { merge: true },
  );
}
export async function completeNotificationAction(
  chatId: string,
  messageId: number,
  itemIndex: number,
): Promise<number[]> {
  const ref = documentKey(queryTable('telegramMessages'), id(chatId, messageId));
  return runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) return [];
    const context = snap.data as TelegramMessageContext;
    const completed = [...new Set([...(context.notification?.completedActions ?? []), itemIndex])];
    transaction.patch(ref, { 'notification.completedActions': completed });
    return completed;
  });
}
