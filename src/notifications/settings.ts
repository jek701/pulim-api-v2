import { db } from '../config/firebase';
import { env } from '../config/env';
import type { NotificationSettings, UserProfile } from '../domain/types';
import { profileRef } from '../repositories/profile.repository';
import { nextDailySlot } from './schedule';

function latestChatId(profile: Partial<UserProfile>): string | null {
  const ids = profile.telegramChatIds ?? [];
  return ids.length ? String(ids[ids.length - 1]) : null;
}

export function notificationDefaults(profile: Partial<UserProfile>, now = Date.now()): NotificationSettings {
  return {
    enabled: true,
    telegram: {
      chatId: latestChatId(profile),
      status: 'unknown',
      lastError: null,
      checkedAt: 0,
    },
    nextDailyAt: nextDailySlot(now, env.NOTIFY_DIGEST_HOUR, env.NOTIFY_TIMEZONE),
    introSentAt: null,
    sentDay: '',
    sentCount: 0,
    reservedDay: '',
    reservedCount: 0,
    lastSentAt: null,
  };
}

export async function ensureNotificationDefaults(uid: string): Promise<void> {
  const ref = profileRef(uid);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const data = snap.data() as UserProfile;
    const patch: Record<string, unknown> = {};
    if (typeof data.createdAt !== 'number') patch.createdAt = data.updatedAt || Date.now();
    if (!data.notifications) patch.notifications = notificationDefaults(data);
    if (Object.keys(patch).length) {
      patch.updatedAt = Date.now();
      transaction.set(ref, patch, { merge: true });
    }
  });
}

async function cancelPending(uid: string, reason: string): Promise<void> {
  while (true) {
    const snapshot = await db.collection('notifications')
      .where('userId', '==', uid)
      .where('status', '==', 'pending')
      .limit(400)
      .get();
    if (snapshot.empty) return;
    const batch = db.batch();
    const now = Date.now();
    snapshot.docs.forEach((document) => batch.set(document.ref, {
      status: 'cancelled', skipReason: reason, leaseUntil: null, updatedAt: now,
    }, { merge: true }));
    await batch.commit();
    if (snapshot.size < 400) return;
  }
}

export async function setNotificationsEnabled(uid: string, enabled: boolean): Promise<NotificationSettings> {
  await ensureNotificationDefaults(uid);
  const now = Date.now();
  await profileRef(uid).update({
    'notifications.enabled': enabled,
    'notifications.nextDailyAt': enabled
      ? nextDailySlot(now, env.NOTIFY_DIGEST_HOUR, env.NOTIFY_TIMEZONE)
      : 0,
    updatedAt: now,
  });
  if (!enabled) await cancelPending(uid, 'disabled');
  const snap = await profileRef(uid).get();
  return snap.data()!.notifications as NotificationSettings;
}

export async function markTelegramReachable(uid: string, chatId: string): Promise<void> {
  await ensureNotificationDefaults(uid);
  const now = Date.now();
  await profileRef(uid).update({
    'notifications.telegram.chatId': String(chatId),
    'notifications.telegram.status': 'reachable',
    'notifications.telegram.lastError': null,
    'notifications.telegram.checkedAt': now,
    updatedAt: now,
  });
}

export async function markTelegramUnavailable(
  uid: string,
  status: 'blocked' | 'unreachable',
  error: string,
): Promise<void> {
  await ensureNotificationDefaults(uid);
  const now = Date.now();
  await profileRef(uid).update({
    'notifications.telegram.status': status,
    'notifications.telegram.lastError': error.slice(0, 500),
    'notifications.telegram.checkedAt': now,
    updatedAt: now,
  });
  await cancelPending(uid, status);
}
