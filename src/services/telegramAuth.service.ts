import { patchValue, saveDocument } from '../db/documents';
import { auth } from '../config/firebaseAuth';
import { env } from '../config/env';
import { verifyTelegramInitData } from './telegramVerify.service';
import { findTelegramUser, saveTelegramUser } from '../repositories/telegramUser.repository';
import { profileRef, profileExists } from '../repositories/profile.repository';
import { seedDefaultCategories } from './profile.service';
import { AppError } from '../utils/AppError';
import { ensureNotificationDefaults, markTelegramReachable } from '../notifications/settings';
export interface TelegramUser {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}
export interface TelegramAuthInput {
  telegramInitData: string;
  chatId: string;
  language?: 'uz' | 'ru' | 'en';
  firebaseIdToken?: string;
}
function buildClaims(tgUser: TelegramUser) {
  const claims: Record<string, string> = {
    provider: 'telegram',
    telegramId: String(tgUser.id),
  };
  if (tgUser.username) claims.telegramUsername = tgUser.username;
  return claims;
}
function displayNameOf(tgUser: TelegramUser, telegramId: string): string {
  const full = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim();
  return full || tgUser.username || `Telegram User ${telegramId}`;
}
async function ensureFirebaseAuthUser(uid: string, tgUser: TelegramUser, telegramId: string) {
  try {
    await auth.getUser(uid);
  } catch (error) {
    if (
      (
        error as {
          code?: string;
        }
      ).code !== 'auth/user-not-found'
    )
      throw error;
    await auth.createUser({
      uid,
      displayName: displayNameOf(tgUser, telegramId),
      photoURL: tgUser.photo_url || undefined,
    });
  }
}
/**
 * Resolve the account behind a Telegram user, creating a brand-new `tg_<telegramId>`
 * account (+ default categories) when there is no telegramUsers mapping yet. Shared
 * by the Mini App (`POST /auth/telegram`) and the bot deep-link login, so both land
 * on the same uid with the same custom claims. Returns the claims to mint a token with.
 */
export async function signInTelegramUser(input: {
  tgUser: TelegramUser;
  chatId: string;
  /** Overrides the profile language (the Mini App sends the UI language). */
  language?: 'uz' | 'ru' | 'en';
  /** Language for a profile created here when `language` is not given. */
  defaultLanguage?: 'uz' | 'ru' | 'en';
}) {
  const { tgUser } = input;
  const telegramId = String(tgUser.id);
  const record = await findTelegramUser(telegramId, input.chatId);
  let uid: string;
  let isNewUser = false;
  if (record) {
    uid = (record.data.profileUid ?? record.data.uid) as string;
  } else {
    uid = `tg_${telegramId}`;
    isNewUser = true;
    await saveDocument(
      profileRef(uid),
      {
        uid,
        name: displayNameOf(tgUser, telegramId),
        onboardingComplete: false,
        salarySources: [],
        familyMembers: [],
        financialGoals: [],
        language: input.language ?? input.defaultLanguage ?? 'uz',
        isTelegramUser: true,
        photoURL: tgUser.photo_url || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      { merge: true },
    );
    await seedDefaultCategories(uid);
  }
  await attachTelegramChat({ uid, tgUser, chatId: input.chatId, language: input.language, linkedExistingAccount: false });
  await ensureFirebaseAuthUser(uid, tgUser, telegramId);
  const claims = buildClaims(tgUser);
  await auth.setCustomUserClaims(uid, claims);
  return { uid, telegramId, isNewUser, claims };
}
// Persist the chatId↔uid mapping and append the chat id to the profile.
async function attachTelegramChat(input: {
  uid: string;
  tgUser: TelegramUser;
  chatId: string;
  language?: 'uz' | 'ru' | 'en';
  linkedExistingAccount: boolean;
}) {
  const telegramId = String(input.tgUser.id);
  await saveTelegramUser({
    chatId: input.chatId,
    telegramId,
    telegramUser: input.tgUser,
    profileUid: input.uid,
  });
  await saveDocument(
    profileRef(input.uid),
    {
      telegramChatIds: patchValue.arrayUnion(Number(telegramId)),
      ...(input.language ? { language: input.language } : {}),
      ...(input.linkedExistingAccount ? {} : { isTelegramUser: true }),
      updatedAt: Date.now(),
    },
    { merge: true },
  );
  await ensureNotificationDefaults(input.uid);
  await markTelegramReachable(input.uid, input.chatId);
}
/**
 * Telegram Mini App sign-in / link.
 *  - No `firebaseIdToken`: resolve an existing telegramUsers mapping, or create a
 *    brand-new `tg_<telegramId>` account (+ default categories). Returns a
 *    Firebase custom token the client signs in with.
 *  - With `firebaseIdToken` (logged-in email user linking Telegram): verify the
 *    token and link the chat to THAT uid. Does not touch the user's custom claims
 *    and returns no custom token.
 */
export async function authenticateTelegram(input: TelegramAuthInput) {
  let tgUser: TelegramUser;
  try {
    const telegramData = verifyTelegramInitData(input.telegramInitData, env.TELEGRAM_BOT_TOKEN, {
      debug: env.DEBUG_TELEGRAM_AUTH,
    });
    if (!telegramData.user) throw new Error('Telegram user payload is missing from init data.');
    tgUser = JSON.parse(telegramData.user) as TelegramUser;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Telegram init data is invalid.';
    throw new AppError(401, 'TELEGRAM_AUTH_FAILED', message);
  }
  const telegramId = String(tgUser.id);
  let uid: string;
  let isNewUser = false;
  let linkedExistingAccount = false;
  let customToken: string | undefined;
  if (input.firebaseIdToken) {
    // Linking flow — prove ownership of the target account by verifying its ID token.
    const decoded = await auth.verifyIdToken(input.firebaseIdToken);
    uid = decoded.uid;
    if (!(await profileExists(uid))) {
      throw AppError.notFound(`Profile "${uid}" was not found.`);
    }
    linkedExistingAccount = true;
    await attachTelegramChat({ uid, tgUser, chatId: input.chatId, language: input.language, linkedExistingAccount });
  } else {
    const signedIn = await signInTelegramUser({ tgUser, chatId: input.chatId, language: input.language });
    uid = signedIn.uid;
    isNewUser = signedIn.isNewUser;
    customToken = await auth.createCustomToken(uid, signedIn.claims);
  }
  return {
    success: true,
    uid,
    chatId: String(input.chatId),
    telegramId,
    isNewUser,
    linkedExistingAccount,
    customToken,
    profile: {
      firstName: tgUser.first_name || null,
      lastName: tgUser.last_name || null,
      username: tgUser.username || null,
      photoUrl: tgUser.photo_url || null,
    },
  };
}
