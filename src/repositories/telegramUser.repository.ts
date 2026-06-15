import { db } from '../config/firebase';

const COLLECTION = 'telegramUsers';

export interface TelegramUserRecord {
  id: string;
  data: FirebaseFirestore.DocumentData;
}

/**
 * Resolve a Telegram user. Primary lookup is by telegramId (the doc key, stable
 * across devices); falls back to a chatId query for legacy records.
 */
export async function findTelegramUser(
  telegramId: string,
  chatId: string,
): Promise<TelegramUserRecord | null> {
  const doc = await db.collection(COLLECTION).doc(String(telegramId)).get();
  if (doc.exists) return { id: doc.id, data: doc.data()! };

  const snapshot = await db
    .collection(COLLECTION)
    .where('chatId', '==', String(chatId))
    .limit(1)
    .get();
  if (snapshot.empty) return null;

  const fallback = snapshot.docs[0]!;
  return { id: fallback.id, data: fallback.data() };
}

interface TelegramUserPayload {
  chatId: string;
  telegramId: string;
  profileUid: string;
  telegramUser: {
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
    photo_url?: string;
  };
}

/**
 * Upsert the chatId→uid mapping. Writes BOTH `profileUid` (canonical) and `uid`
 * (what the frontend + firestore.rules read) during the transition window.
 * Never deletes existing records.
 */
export async function saveTelegramUser(payload: TelegramUserPayload): Promise<void> {
  const { chatId, telegramId, telegramUser, profileUid } = payload;
  await db.collection(COLLECTION).doc(String(telegramId)).set(
    {
      chatId: String(chatId),
      telegramId: String(telegramId),
      profileUid,
      uid: profileUid, // back-compat with client reads / security rules
      username: telegramUser.username || null,
      firstName: telegramUser.first_name || null,
      lastName: telegramUser.last_name || null,
      languageCode: telegramUser.language_code || null,
      photoUrl: telegramUser.photo_url || null,
      linkedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}
