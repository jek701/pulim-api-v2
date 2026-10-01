import { db, Timestamp } from '../config/firebase';
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
  options: { categoryIds: string[]; cardIds: string[]; page: number } | null;
  notification?: {
    payload: NotificationPayload;
    introIncluded: boolean;
    completedActions: number[];
  };
}

const id = (chatId: string, messageId: number) => `${chatId}_${messageId}`;

export async function saveMessage(context: TelegramMessageContext): Promise<void> {
  await db.collection('telegramMessages').doc(id(context.chatId, context.messageId)).set({
    ...context,
    createdAt: Date.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86_400_000),
  });
}

export async function getMessage(chatId: string, messageId: number): Promise<TelegramMessageContext | null> {
  const snap = await db.collection('telegramMessages').doc(id(chatId, messageId)).get();
  return snap.exists ? snap.data() as TelegramMessageContext : null;
}

export async function updateMessageOptions(
  chatId: string,
  messageId: number,
  options: TelegramMessageContext['options'],
): Promise<void> {
  await db.collection('telegramMessages').doc(id(chatId, messageId)).set({ options }, { merge: true });
}

export async function completeNotificationAction(
  chatId: string,
  messageId: number,
  itemIndex: number,
): Promise<number[]> {
  const ref = db.collection('telegramMessages').doc(id(chatId, messageId));
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return [];
    const context = snap.data() as TelegramMessageContext;
    const completed = [...new Set([...(context.notification?.completedActions ?? []), itemIndex])];
    transaction.update(ref, { 'notification.completedActions': completed });
    return completed;
  });
}
