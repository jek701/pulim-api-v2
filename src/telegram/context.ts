import type { UserProfile } from '../domain/types';
import { getProfile } from '../repositories/profile.repository';
import { findTelegramUser } from '../repositories/telegramUser.repository';
import { normalizeLanguage } from './i18n';
import type { SupportedLanguage } from './types';

export interface TelegramUserContext {
  uid: string;
  profile: UserProfile & { id: string };
  language: SupportedLanguage;
}

export async function resolveUserContext(
  telegramId: string,
  chatId: string,
): Promise<TelegramUserContext | null> {
  const record = await findTelegramUser(telegramId, chatId);
  const uid = record?.data.profileUid ?? record?.data.uid;
  if (typeof uid !== 'string' || !uid) return null;
  const profile = await getProfile(uid);
  if (!profile) return null;
  return {
    uid,
    profile,
    language: normalizeLanguage(profile.language ?? record?.data.languageCode),
  };
}

