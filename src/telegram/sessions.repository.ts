import { db, Timestamp } from '../config/firebase';

const collection = () => db.collection('telegramSessions');

export async function clearSession(chatId: string): Promise<void> {
  await collection().doc(chatId).delete();
}

export async function getSession(chatId: string): Promise<FirebaseFirestore.DocumentData | null> {
  const snap = await collection().doc(chatId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  const expiresAt = data.expiresAt as FirebaseFirestore.Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) {
    await snap.ref.delete();
    return null;
  }
  return data;
}

export async function saveSession(chatId: string, data: Record<string, unknown>): Promise<void> {
  await collection().doc(chatId).set({
    ...data,
    createdAt: Date.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60_000),
  });
}

