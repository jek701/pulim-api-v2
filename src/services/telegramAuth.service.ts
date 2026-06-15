import { auth, FieldValue } from '../config/firebase';
import { env } from '../config/env';
import { verifyTelegramInitData } from './telegramVerify.service';
import { findTelegramUser, saveTelegramUser } from '../repositories/telegramUser.repository';
import { profileRef, profileExists } from '../repositories/profile.repository';
import { ensureTrial, seedDefaultCategories } from './profile.service';
import { AppError } from '../utils/AppError';

interface TelegramUser {
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
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
    await auth.createUser({
      uid,
      displayName: displayNameOf(tgUser, telegramId),
      photoURL: tgUser.photo_url || undefined,
    });
  }
}

/**
 * Telegram Mini App sign-in / link.
 *  - No `firebaseIdToken`: resolve an existing telegramUsers mapping, or create a
 *    brand-new `tg_<telegramId>` account (+ trial + default categories). Returns a
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

  if (input.firebaseIdToken) {
    // Linking flow — prove ownership of the target account by verifying its ID token.
    const decoded = await auth.verifyIdToken(input.firebaseIdToken);
    uid = decoded.uid;
    if (!(await profileExists(uid))) {
      throw AppError.notFound(`Profile "${uid}" was not found.`);
    }
    linkedExistingAccount = true;
  } else {
    const record = await findTelegramUser(telegramId, input.chatId);
    if (record) {
      uid = (record.data.profileUid ?? record.data.uid) as string;
    } else {
      uid = `tg_${telegramId}`;
      isNewUser = true;
      await profileRef(uid).set(
        {
          uid,
          name: displayNameOf(tgUser, telegramId),
          onboardingComplete: false,
          salarySources: [],
          familyMembers: [],
          financialGoals: [],
          isTelegramUser: true,
          photoURL: tgUser.photo_url || null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      await ensureTrial(uid);
      await seedDefaultCategories(uid);
    }
  }

  // Persist the chatId↔uid mapping and append the chat id to the profile.
  await saveTelegramUser({ chatId: input.chatId, telegramId, telegramUser: tgUser, profileUid: uid });
  await profileRef(uid).set(
    {
      telegramChatIds: FieldValue.arrayUnion(Number(telegramId)),
      ...(linkedExistingAccount ? {} : { isTelegramUser: true }),
      updatedAt: Date.now(),
    },
    { merge: true },
  );

  let customToken: string | undefined;
  if (!linkedExistingAccount) {
    await ensureFirebaseAuthUser(uid, tgUser, telegramId);
    await auth.setCustomUserClaims(uid, buildClaims(tgUser));
    customToken = await auth.createCustomToken(uid, buildClaims(tgUser));
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
