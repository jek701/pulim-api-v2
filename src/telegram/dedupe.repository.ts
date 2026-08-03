import { db, Timestamp } from '../config/firebase';
import { deserializeUpdatePayload, serializeUpdatePayload } from './updatePayload';

const collection = () => db.collection('telegramUpdates');
const LEASE_MS = 2 * 60_000;

export async function enqueueUpdate(updateId: number, payload: unknown): Promise<boolean> {
  const ref = collection().doc(String(updateId));
  try {
    await ref.create({
      userId: null,
      payloadJson: serializeUpdatePayload(payload),
      status: 'pending',
      attempts: 0,
      receivedAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
    });
    return true;
  } catch (error) {
    if ((error as { code?: number | string }).code === 6
      || (error as { code?: number | string }).code === 'already-exists') return false;
    throw error;
  }
}

export async function claimUpdate(updateId: number): Promise<boolean> {
  const ref = collection().doc(String(updateId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data()!;
    const now = Date.now();
    if (data.status === 'completed') return false;
    if (data.status === 'processing' && Number(data.leaseUntil ?? 0) > now) return false;
    tx.set(ref, {
      status: 'processing',
      attempts: Number(data.attempts ?? 0) + 1,
      leaseUntil: now + LEASE_MS,
      updatedAt: now,
    }, { merge: true });
    return true;
  });
}

export async function completeUpdate(updateId: number, userId: string | null): Promise<void> {
  await collection().doc(String(updateId)).set({
    status: 'completed', userId, payload: null, payloadJson: null, leaseUntil: null, updatedAt: Date.now(),
  }, { merge: true });
}

export async function failUpdate(updateId: number, errorCode: string): Promise<void> {
  await collection().doc(String(updateId)).set({
    status: 'failed', errorCode, leaseUntil: null, updatedAt: Date.now(),
  }, { merge: true });
}

export async function abandonUpdate(updateId: number, errorCode: string): Promise<void> {
  await collection().doc(String(updateId)).set({
    status: 'abandoned', errorCode, payload: null, payloadJson: null, leaseUntil: null, updatedAt: Date.now(),
  }, { merge: true });
}

export async function listRecoverableUpdates(limit = 20): Promise<Array<{ updateId: number; payload: unknown; attempts: number }>> {
  const snapshots = await Promise.all([
    collection().where('status', '==', 'pending').limit(limit).get(),
    collection().where('status', '==', 'failed').limit(limit).get(),
    collection().where('status', '==', 'processing').limit(limit).get(),
  ]);
  const now = Date.now();
  const rows = snapshots.flatMap((snapshot) => snapshot.docs).filter((document) => {
    const data = document.data();
    return (data.payloadJson || data.payload)
      && (data.status !== 'processing' || Number(data.leaseUntil ?? 0) <= now);
  });
  return rows.slice(0, limit).map((document) => ({
    updateId: Number(document.id),
    payload: deserializeUpdatePayload(document.data().payloadJson, document.data().payload),
    attempts: Number(document.data().attempts ?? 0),
  }));
}
