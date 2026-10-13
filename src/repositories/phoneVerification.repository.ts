import {
  Timestamp,
  documentKey,
  queryTable,
  readDocument,
  runSqlTransaction,
  saveDocument,
} from '../db/documents';
const COLLECTION = 'phoneVerifications';
export interface PhoneVerificationRecord {
  /** SHA-256 of `code:phone` — the plain code is never stored. */
  codeHash: string;
  purpose: 'signin' | 'link';
  /** uid the code is bound to in `link` mode. */
  targetUid: string | null;
  expiresAtMs: number;
  /** Wrong-code guesses against the current code. */
  attempts: number;
  /** Sends inside the current rolling hour window. */
  sendCount: number;
  sendWindowStartMs: number;
  lastSentAtMs: number;
  consumedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
/** Doc id: bare digits, so `+998 90 123 45 67` and `998901234567` share one record. */
const ref = (phoneDigits: string) => documentKey(queryTable(COLLECTION), phoneDigits);
export async function getVerification(
  phoneDigits: string,
): Promise<PhoneVerificationRecord | null> {
  const snap = await readDocument(ref(phoneDigits));
  return snap.exists ? (snap.data as PhoneVerificationRecord) : null;
}
interface SaveInput {
  phoneDigits: string;
  codeHash: string;
  purpose: 'signin' | 'link';
  targetUid: string | null;
  expiresAtMs: number;
  sendCount: number;
  sendWindowStartMs: number;
  /** TTL field for a Firestore policy on `expiresAt` — keeps the collection self-cleaning. */
  retainUntilMs: number;
}
export async function saveIssuedCode(input: SaveInput): Promise<void> {
  const now = Date.now();
  const existed = (await readDocument(ref(input.phoneDigits))).exists;
  await saveDocument(
    ref(input.phoneDigits),
    {
      codeHash: input.codeHash,
      purpose: input.purpose,
      targetUid: input.targetUid,
      expiresAtMs: input.expiresAtMs,
      attempts: 0,
      sendCount: input.sendCount,
      sendWindowStartMs: input.sendWindowStartMs,
      lastSentAtMs: now,
      consumedAt: null,
      expiresAt: Timestamp.fromMillis(input.retainUntilMs),
      ...(existed ? {} : { createdAt: now }),
      updatedAt: now,
    },
    { merge: true },
  );
}
export async function recordFailedAttempt(phoneDigits: string): Promise<number> {
  return runSqlTransaction(async (tx) => {
    const snap = await tx.read(ref(phoneDigits));
    const attempts = Number((snap.data as PhoneVerificationRecord | undefined)?.attempts ?? 0) + 1;
    tx.save(ref(phoneDigits), { attempts, updatedAt: Date.now() }, { merge: true });
    return attempts;
  });
}
/**
 * Atomically burns the code so a leaked SMS cannot be replayed and two parallel
 * requests cannot both mint a session. Returns false when it was already used.
 */
export async function consumeCode(phoneDigits: string, codeHash: string): Promise<boolean> {
  return runSqlTransaction(async (tx) => {
    const snap = await tx.read(ref(phoneDigits));
    const data = snap.data as PhoneVerificationRecord | undefined;
    if (!data || data.consumedAt || data.codeHash !== codeHash) return false;
    tx.save(ref(phoneDigits), { consumedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
    return true;
  });
}
