import {
  DocumentData,
  Timestamp,
  documentKey,
  queryTable,
  readDocument,
  removeDocument,
  saveDocument,
} from '../db/documents';
const collection = () => queryTable('telegramSessions');
export async function clearSession(chatId: string): Promise<void> {
  await removeDocument(documentKey(collection(), chatId));
}
export async function getSession(chatId: string): Promise<DocumentData | null> {
  const snap = await readDocument(documentKey(collection(), chatId));
  if (!snap.exists) return null;
  const data = snap.data!;
  const expiresAt = data.expiresAt as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) {
    await removeDocument(snap.key);
    return null;
  }
  return data;
}
export async function saveSession(chatId: string, data: Record<string, unknown>): Promise<void> {
  await saveDocument(documentKey(collection(), chatId), {
    ...data,
    createdAt: Date.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60000),
  });
}
