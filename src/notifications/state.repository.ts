import { db } from '../config/firebase';
import type { NotificationState } from './types';

export const notificationStateRef = (uid: string) => db.collection('notificationState').doc(uid);

export function emptyNotificationState(uid: string): NotificationState {
  return {
    userId: uid,
    seen: {},
    trialAvailableSentCount: 0,
    lastTrialAvailableAt: null,
    weeklyEmptyStreak: 0,
    updatedAt: 0,
  };
}

export function parseNotificationState(uid: string, data: FirebaseFirestore.DocumentData | undefined): NotificationState {
  const fallback = emptyNotificationState(uid);
  if (!data) return fallback;
  return {
    userId: uid,
    seen: typeof data.seen === 'object' && data.seen ? data.seen as Record<string, number> : {},
    trialAvailableSentCount: Number(data.trialAvailableSentCount ?? 0),
    lastTrialAvailableAt: typeof data.lastTrialAvailableAt === 'number' ? data.lastTrialAvailableAt : null,
    weeklyEmptyStreak: Number(data.weeklyEmptyStreak ?? 0),
    updatedAt: Number(data.updatedAt ?? 0),
  };
}

export async function getNotificationState(uid: string): Promise<NotificationState> {
  const snap = await notificationStateRef(uid).get();
  return parseNotificationState(uid, snap.data());
}

export function pruneSeen(seen: Record<string, number>, now: number): Record<string, number> {
  const cutoff = now - 90 * 86_400_000;
  return Object.fromEntries(Object.entries(seen).filter(([, timestamp]) => timestamp >= cutoff));
}
