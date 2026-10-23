import { documentKey, queryTable, readDocument, insertDocument, runSqlTransaction } from '../db/documents';
const COLLECTION = 'telegramLoginRequests';
export type TelegramLoginStatus = 'pending' | 'approved' | 'consumed';
export interface TelegramLoginRequestRecord {
  status: TelegramLoginStatus;
  /** SHA-256 of the device secret — the plain secret only ever lives on the device. */
  deviceSecretHash: string;
  /** App UI language, used for a new profile and the bot reply to an unknown user. */
  language: 'uz' | 'ru' | 'en' | null;
  /** Pending: 5 min after creation. Approved: 5 min after the bot step. */
  expiresAtMs: number;
  telegramId: string | null;
  chatId: string | null;
  profileUid: string | null;
  /** Custom-token claims resolved at the bot step (`provider`, `telegramId`, `telegramUsername`). */
  claims: Record<string, string> | null;
  isNewUser: boolean;
  approvedAt: number | null;
  consumedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
/** Doc id = request id = SHA-256 of the deep-link nonce, so the bot finds it by key. */
const ref = (requestId: string) => documentKey(queryTable(COLLECTION), requestId);
export async function getLoginRequest(requestId: string): Promise<TelegramLoginRequestRecord | null> {
  const snap = await readDocument(ref(requestId));
  return snap.exists ? (snap.data as TelegramLoginRequestRecord) : null;
}
export async function createLoginRequest(input: {
  requestId: string;
  deviceSecretHash: string;
  language: 'uz' | 'ru' | 'en' | null;
  expiresAtMs: number;
}): Promise<void> {
  const now = Date.now();
  const record: TelegramLoginRequestRecord = {
    status: 'pending',
    deviceSecretHash: input.deviceSecretHash,
    language: input.language,
    expiresAtMs: input.expiresAtMs,
    telegramId: null,
    chatId: null,
    profileUid: null,
    claims: null,
    isNewUser: false,
    approvedAt: null,
    consumedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await insertDocument(ref(input.requestId), { ...record });
}
export type ApproveOutcome = 'approved' | 'already_approved' | 'used' | 'expired' | 'not_found';
/**
 * Attaches the Telegram account to a pending request. A repeat from the same Telegram
 * user (webhook retry, second tap) is `already_approved`; anyone else gets `used`.
 */
export async function approveLoginRequest(
  requestId: string,
  approval: {
    telegramId: string;
    chatId: string;
    profileUid: string;
    claims: Record<string, string>;
    isNewUser: boolean;
    exchangeWindowMs: number;
  },
): Promise<ApproveOutcome> {
  return runSqlTransaction(async (tx) => {
    const snap = await tx.read(ref(requestId));
    const data = snap.data as TelegramLoginRequestRecord | undefined;
    const now = Date.now();
    if (!snap.exists || !data) return 'not_found';
    if (data.status !== 'pending') {
      return data.status === 'approved' && data.telegramId === approval.telegramId
        ? 'already_approved'
        : 'used';
    }
    if (data.expiresAtMs <= now) return 'expired';
    tx.save(
      ref(requestId),
      {
        status: 'approved',
        telegramId: approval.telegramId,
        chatId: approval.chatId,
        profileUid: approval.profileUid,
        claims: approval.claims,
        isNewUser: approval.isNewUser,
        approvedAt: now,
        expiresAtMs: now + approval.exchangeWindowMs,
        updatedAt: now,
      },
      { merge: true },
    );
    return 'approved';
  });
}
/** Burns an approved request so its custom token is handed out exactly once. */
export async function consumeLoginRequest(requestId: string): Promise<boolean> {
  return runSqlTransaction(async (tx) => {
    const snap = await tx.read(ref(requestId));
    const data = snap.data as TelegramLoginRequestRecord | undefined;
    const now = Date.now();
    if (!data || data.status !== 'approved' || data.expiresAtMs <= now) return false;
    tx.save(ref(requestId), { status: 'consumed', consumedAt: now, updatedAt: now }, { merge: true });
    return true;
  });
}
