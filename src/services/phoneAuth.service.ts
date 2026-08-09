import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { auth } from '../config/firebase';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { profileExists } from '../repositories/profile.repository';
import {
  consumeCode,
  getVerification,
  recordFailedAttempt,
  saveIssuedCode,
} from '../repositories/phoneVerification.repository';
import { sendSms } from './eskiz.service';

/**
 * Phone sign-in on top of the Eskiz SMS gateway.
 *
 * The API owns the whole code lifecycle (issue → SMS → verify) and, on success,
 * mints a Firebase custom token. Firebase Auth stays the session/uid store, so
 * `/v1/*` keeps verifying ID tokens and existing phone users keep their uid and
 * their data — only the delivery of the code moved off Firebase (which is also
 * what let us drop reCAPTCHA: rate limiting is now ours).
 */

const SEND_WINDOW_MS = 3_600_000;
const CODE_LENGTH = 6;

export type PhoneAuthPurpose = 'signin' | 'link';
export type SmsLanguage = 'uz' | 'ru' | 'en';

/**
 * Text must match a template approved in the Eskiz cabinet, otherwise the
 * gateway rejects the send. Keep each variant to one SMS part (160 Latin
 * characters, 70 Cyrillic).
 */
const MESSAGE_TEMPLATES: Record<SmsLanguage, (code: string) => string> = {
  uz: (code) => `Pulim: tasdiqlash kodi ${code}. Kodni hech kimga bermang.`,
  ru: (code) => `Pulim: код для входа ${code}. Никому не сообщайте его.`,
  en: (code) => `Pulim: your verification code is ${code}. Do not share it.`,
};

export interface NormalizedPhone {
  /** Bare digits for Eskiz, e.g. `998901234567`. */
  digits: string;
  /** E.164 for Firebase Auth, e.g. `+998901234567`. */
  e164: string;
}

/** Uzbek numbers only — `/message/sms/send` is domestic; other countries need send-global. */
export function normalizePhone(raw: string): NormalizedPhone {
  const digits = raw.replace(/\D/g, '');
  if (!/^998\d{9}$/.test(digits)) {
    throw new AppError(
      400,
      'PHONE_INVALID',
      'Enter an Uzbek mobile number in the +998 XX XXX XX XX format.',
    );
  }
  return { digits, e164: `+${digits}` };
}

function hashCode(digits: string, code: string): string {
  // Keyed so a leaked Firestore export cannot be brute-forced offline (10^6 codes).
  const key = env.PHONE_CODE_PEPPER || `${env.FIREBASE_PROJECT_ID}:phone-auth`;
  return createHmac('sha256', key).update(`${digits}:${code}`).digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function pickLanguage(language?: string): SmsLanguage {
  return language === 'ru' || language === 'en' || language === 'uz' ? language : 'uz';
}

/** Resolves the uid a `link` request is allowed to touch, proving ownership via its ID token. */
async function resolveLinkTarget(firebaseIdToken: string | undefined): Promise<string> {
  if (!firebaseIdToken) {
    throw AppError.unauthorized('Linking a phone number requires a signed-in user.');
  }
  const decoded = await auth.verifyIdToken(firebaseIdToken);
  if (!(await profileExists(decoded.uid))) {
    throw AppError.notFound(`Profile "${decoded.uid}" was not found.`);
  }
  return decoded.uid;
}

/** 409s when the number already belongs to a different account. */
async function assertPhoneFree(e164: string, targetUid: string): Promise<void> {
  const owner = await findUserByPhone(e164);
  if (owner && owner !== targetUid) {
    throw new AppError(
      409,
      'PHONE_ALREADY_LINKED',
      'This phone number is already used by another account.',
    );
  }
}

async function findUserByPhone(e164: string): Promise<string | null> {
  try {
    return (await auth.getUserByPhoneNumber(e164)).uid;
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') return null;
    throw error;
  }
}

export interface SendCodeInput {
  phone: string;
  purpose?: PhoneAuthPurpose;
  language?: string;
  firebaseIdToken?: string;
}

export async function sendPhoneCode(input: SendCodeInput) {
  const purpose: PhoneAuthPurpose = input.purpose ?? 'signin';
  const { digits, e164 } = normalizePhone(input.phone);
  const targetUid = purpose === 'link' ? await resolveLinkTarget(input.firebaseIdToken) : null;
  if (targetUid) await assertPhoneFree(e164, targetUid);

  const now = Date.now();
  const existing = await getVerification(digits);

  if (existing) {
    const waitMs = existing.lastSentAtMs + env.PHONE_CODE_RESEND_COOLDOWN_SECONDS * 1_000 - now;
    if (waitMs > 0) {
      throw new AppError(
        429,
        'RESEND_TOO_SOON',
        'A code was just sent. Please wait before requesting another one.',
        { retryAfter: Math.ceil(waitMs / 1_000) },
      );
    }
  }

  const windowOpen = existing && now - existing.sendWindowStartMs < SEND_WINDOW_MS;
  const sendWindowStartMs = windowOpen ? existing!.sendWindowStartMs : now;
  const sendCount = (windowOpen ? existing!.sendCount : 0) + 1;
  if (sendCount > env.PHONE_CODE_MAX_SENDS_PER_HOUR) {
    throw new AppError(
      429,
      'TOO_MANY_SENDS',
      'Too many codes requested for this number. Please try again later.',
      { retryAfter: Math.ceil((sendWindowStartMs + SEND_WINDOW_MS - now) / 1_000) },
    );
  }

  const code = generateCode();
  const expiresAtMs = now + env.PHONE_CODE_TTL_SECONDS * 1_000;
  const message = MESSAGE_TEMPLATES[pickLanguage(input.language)](code);

  // Persist before sending: a delivered SMS whose code we failed to store would
  // be unverifiable, while a stored code we failed to send is simply retried.
  await saveIssuedCode({
    phoneDigits: digits,
    codeHash: hashCode(digits, code),
    purpose,
    targetUid,
    expiresAtMs,
    sendCount,
    sendWindowStartMs,
    retainUntilMs: Math.max(expiresAtMs, sendWindowStartMs + SEND_WINDOW_MS) + 86_400_000,
  });

  let requestId: string | null = null;
  if (env.PHONE_AUTH_DEBUG_ECHO_CODE) {
    logger.warn({ phone: e164 }, '[phone-auth] debug mode: code returned in the response, no SMS sent');
  } else {
    requestId = (await sendSms(digits, message)).requestId;
  }

  return {
    success: true,
    phone: e164,
    expiresIn: env.PHONE_CODE_TTL_SECONDS,
    resendAfter: env.PHONE_CODE_RESEND_COOLDOWN_SECONDS,
    requestId,
    ...(env.PHONE_AUTH_DEBUG_ECHO_CODE ? { debugCode: code } : {}),
  };
}

export interface VerifyCodeInput {
  phone: string;
  code: string;
  purpose?: PhoneAuthPurpose;
  firebaseIdToken?: string;
}

export async function verifyPhoneCode(input: VerifyCodeInput) {
  const purpose: PhoneAuthPurpose = input.purpose ?? 'signin';
  const { digits, e164 } = normalizePhone(input.phone);
  const record = await getVerification(digits);

  if (!record || record.consumedAt) {
    throw new AppError(400, 'CODE_NOT_FOUND', 'Request a new code for this number.');
  }
  if (record.purpose !== purpose) {
    throw new AppError(400, 'CODE_NOT_FOUND', 'Request a new code for this number.');
  }
  if (record.attempts >= env.PHONE_CODE_MAX_ATTEMPTS) {
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new one.');
  }
  if (record.expiresAtMs <= Date.now()) {
    throw new AppError(400, 'CODE_EXPIRED', 'The code has expired. Request a new one.');
  }

  const submittedHash = hashCode(digits, input.code);
  if (!hashesMatch(submittedHash, record.codeHash)) {
    const attempts = await recordFailedAttempt(digits);
    throw new AppError(400, 'CODE_INVALID', 'The code is incorrect.', {
      attemptsLeft: Math.max(env.PHONE_CODE_MAX_ATTEMPTS - attempts, 0),
    });
  }

  // `link` re-verifies the ID token: the code alone must not be able to attach a
  // number to an account other than the one that asked for it.
  const linkUid = purpose === 'link' ? await resolveLinkTarget(input.firebaseIdToken) : null;
  if (linkUid && record.targetUid && linkUid !== record.targetUid) {
    throw new AppError(400, 'CODE_NOT_FOUND', 'Request a new code for this number.');
  }
  if (linkUid) await assertPhoneFree(e164, linkUid);

  if (!(await consumeCode(digits, submittedHash))) {
    throw new AppError(400, 'CODE_NOT_FOUND', 'Request a new code for this number.');
  }

  if (linkUid) {
    try {
      await auth.updateUser(linkUid, { phoneNumber: e164 });
    } catch (error) {
      // Lost a race against another account claiming the same number.
      if ((error as { code?: string }).code === 'auth/phone-number-already-exists') {
        throw new AppError(
          409,
          'PHONE_ALREADY_LINKED',
          'This phone number is already used by another account.',
        );
      }
      throw error;
    }
    logger.info({ uid: linkUid }, '[phone-auth] phone linked');
    return { success: true, uid: linkUid, isNewUser: false, linked: true };
  }

  let uid = await findUserByPhone(e164);
  const isNewUser = uid === null;
  if (!uid) {
    uid = (await auth.createUser({ phoneNumber: e164 })).uid;
  }

  // Existing claims are preserved: a Telegram user who signs in by phone must not
  // lose `provider: 'telegram'`. `phone` is what marks the number as verified for
  // custom-token sessions, where Firebase does not populate `phone_number`.
  const current = (await auth.getUser(uid)).customClaims ?? {};
  const claims: Record<string, unknown> = {
    ...current,
    provider: current.provider ?? 'phone',
    phone: e164,
  };
  await auth.setCustomUserClaims(uid, claims);
  const customToken = await auth.createCustomToken(uid, claims);

  logger.info({ uid, isNewUser }, '[phone-auth] sign-in');
  return { success: true, uid, isNewUser, customToken };
}
