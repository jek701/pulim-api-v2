import { db, Timestamp } from '../config/firebase';
import { env } from '../config/env';
import { createHash } from 'node:crypto';
import type { DraftReason } from './types';
import type { ParsedOperationKind } from './types';

export interface DraftInput {
  userId: string;
  chatId: string;
  sourceMessageId: number;
  sourceText: string;
  index: number;
  operationKey: string;
  operationType?: ParsedOperationKind;
  draft: Record<string, unknown>;
  amountAlternative: number | null;
  suggestion: { categoryName: string; categoryIcon: string } | null;
  reasons: DraftReason[];
  status?: 'pending' | 'waiting_fx';
}

export async function createDraft(input: DraftInput): Promise<({ id: string } & DraftInput & Record<string, unknown>)> {
  const id = createHash('sha256').update(`${input.userId}:${input.operationKey}`).digest('hex');
  const ref = db.collection('telegramDrafts').doc(id);
  const now = Date.now();
  const status = input.status ?? 'pending';
  const ttlHours = status === 'waiting_fx'
    ? env.TELEGRAM_FX_MAX_RETRY_HOURS
    : env.TELEGRAM_DRAFT_TTL_HOURS;
  const expiresAtMs = now + ttlHours * 60 * 60_000;
  try {
    await ref.create({
      ...input,
      sourceText: input.sourceText.slice(0, 500),
      status,
      transactionId: null,
      attempts: 0,
      nextAttemptAt: status === 'waiting_fx' ? now : null,
      createdAt: now,
      updatedAt: now,
      expiresAtMs,
      expiresAt: Timestamp.fromMillis(expiresAtMs),
    });
    return { id: ref.id, ...input, status };
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code !== 6 && code !== 'already-exists') throw error;
    const existing = await ref.get();
    return { id: existing.id, ...input, ...existing.data() };
  }
}

export async function updateDraft(id: string, patch: Record<string, unknown>): Promise<void> {
  await db.collection('telegramDrafts').doc(id).set({ ...patch, updatedAt: Date.now() }, { merge: true });
}

export async function getOwnedDraft(id: string, uid: string): Promise<FirebaseFirestore.DocumentData | null> {
  const snap = await db.collection('telegramDrafts').doc(id).get();
  if (!snap.exists || snap.data()!.userId !== uid) return null;
  return { id: snap.id, ...snap.data() };
}
