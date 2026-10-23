import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { auth } from '../config/firebaseAuth';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { signInTelegramUser, type TelegramUser } from './telegramAuth.service';
import {
  approveLoginRequest,
  consumeLoginRequest,
  createLoginRequest,
  getLoginRequest,
  type ApproveOutcome,
} from '../repositories/telegramLoginRequest.repository';

/**
 * Native-app login through the Telegram bot (deep-link flow).
 *
 *  1. App: `POST /auth/telegram/login-request` → `{ requestId, deviceSecret, deepLink }`.
 *  2. App opens `https://t.me/<bot>?start=login_<nonce>`; the user presses Start.
 *  3. Bot: `/start login_<nonce>` resolves/creates the `tg_<telegramId>` account
 *     exactly like `POST /auth/telegram` and marks the request approved.
 *  4. App polls `POST /auth/telegram/login-request/:requestId/exchange {deviceSecret}`
 *     and gets a Firebase custom token once.
 *
 * Only hashes are stored: the request id is SHA-256 of the nonce (so the bot finds
 * the request by key) and the device secret is kept as SHA-256.
 */

export const LOGIN_START_PREFIX = 'login_';
/** How long a fresh request waits for the bot step. */
export const LOGIN_REQUEST_TTL_MS = 5 * 60_000;
/** How long the app has to pick up the token after the bot step. */
export const LOGIN_EXCHANGE_WINDOW_MS = 5 * 60_000;
// 24 random bytes → 32 base64url chars; `login_` + nonce stays under Telegram's 64-char start limit.
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

type Language = 'uz' | 'ru' | 'en';

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const botUsername = () => env.TELEGRAM_BOT_USERNAME.trim().replace(/^@/, '');

function secretMatches(secret: string, expectedHash: string): boolean {
  const received = Buffer.from(sha256(secret));
  const expected = Buffer.from(expectedHash);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function createTelegramLoginRequest(input: { language?: Language }) {
  const username = botUsername();
  if (!username) {
    throw new AppError(503, 'TELEGRAM_LOGIN_UNAVAILABLE', 'Telegram login is not configured.');
  }
  const nonce = randomBytes(24).toString('base64url');
  const deviceSecret = randomBytes(32).toString('base64url');
  const requestId = sha256(nonce);
  const expiresAtMs = Date.now() + LOGIN_REQUEST_TTL_MS;
  await createLoginRequest({
    requestId,
    deviceSecretHash: sha256(deviceSecret),
    language: input.language ?? null,
    expiresAtMs,
  });
  return {
    requestId,
    deviceSecret,
    deepLink: `https://t.me/${username}?start=${LOGIN_START_PREFIX}${nonce}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export type BotLoginResult =
  | { status: 'approved'; uid: string }
  | { status: Exclude<ApproveOutcome, 'approved' | 'already_approved'>; language: Language | null };

/** The bot step: called for `/start login_<nonce>`. Never throws for a bad nonce. */
export async function approveTelegramLogin(input: {
  nonce: string;
  tgUser: TelegramUser;
  chatId: string;
  defaultLanguage: Language;
}): Promise<BotLoginResult> {
  if (!NONCE_PATTERN.test(input.nonce)) return { status: 'not_found', language: null };
  const requestId = sha256(input.nonce);
  const request = await getLoginRequest(requestId);
  if (!request) return { status: 'not_found', language: null };
  const telegramId = String(input.tgUser.id);
  const language = request.language;
  if (request.status === 'approved' && request.telegramId === telegramId && request.profileUid) {
    return { status: 'approved', uid: request.profileUid };
  }
  if (request.status !== 'pending') return { status: 'used', language };
  if (request.expiresAtMs <= Date.now()) return { status: 'expired', language };

  // Idempotent: a webhook retry after a crash here resolves the same account again.
  const signedIn = await signInTelegramUser({
    tgUser: input.tgUser,
    chatId: input.chatId,
    defaultLanguage: language ?? input.defaultLanguage,
  });
  const outcome = await approveLoginRequest(requestId, {
    telegramId,
    chatId: input.chatId,
    profileUid: signedIn.uid,
    claims: signedIn.claims,
    isNewUser: signedIn.isNewUser,
    exchangeWindowMs: LOGIN_EXCHANGE_WINDOW_MS,
  });
  if (outcome === 'approved' || outcome === 'already_approved') {
    logger.info({ requestId: requestId.slice(0, 8), isNewUser: signedIn.isNewUser }, 'telegram.login.approved');
    return { status: 'approved', uid: signedIn.uid };
  }
  return { status: outcome, language };
}

export async function exchangeTelegramLogin(requestId: string, deviceSecret: string) {
  const request = await getLoginRequest(requestId);
  if (!request) {
    throw new AppError(404, 'LOGIN_REQUEST_NOT_FOUND', 'Login request was not found.');
  }
  if (!secretMatches(deviceSecret, request.deviceSecretHash)) {
    throw new AppError(401, 'LOGIN_REQUEST_SECRET_INVALID', 'Device secret does not match.');
  }
  if (request.status === 'consumed') {
    throw new AppError(410, 'LOGIN_REQUEST_USED', 'Login request was already used.');
  }
  if (request.expiresAtMs <= Date.now()) {
    throw new AppError(410, 'LOGIN_REQUEST_EXPIRED', 'Login request has expired.');
  }
  if (request.status === 'pending') {
    return { status: 'pending' as const, expiresAt: new Date(request.expiresAtMs).toISOString() };
  }
  if (!request.profileUid || !request.claims) {
    throw new AppError(500, 'LOGIN_REQUEST_INVALID', 'Login request is incomplete.');
  }
  // Mint first (local signing, no side effects), then burn; a lost race discards the token.
  const customToken = await auth.createCustomToken(request.profileUid, request.claims);
  if (!(await consumeLoginRequest(requestId))) {
    throw new AppError(410, 'LOGIN_REQUEST_USED', 'Login request was already used.');
  }
  return {
    status: 'approved' as const,
    customToken,
    uid: request.profileUid,
    isNewUser: request.isNewUser,
  };
}
