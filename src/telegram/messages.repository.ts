import { db, Timestamp } from '../config/firebase';

export interface TelegramMessageContext {
  userId: string;
  chatId: string;
  messageId: number;
  kind: 'saved' | 'draft' | 'summary' | 'edit';
  items: Array<{ draftId: string | null; transactionId: string | null }>;
  options: { categoryIds: string[]; cardIds: string[]; page: number } | null;
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

