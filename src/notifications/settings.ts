import {
  filterQuery,
  limitQuery,
  patchDocument,
  queryTable,
  readDocument,
  runSqlTransaction,
  writeBatch,
} from '../db/documents';
import { env } from '../config/env';
import type { NotificationSettings, UserProfile } from '../domain/types';
import { profileRef } from '../repositories/profile.repository';
import { nextDailySlot } from './schedule';
import { normalizePushSettings } from '../push/settings';
import type { NotificationSettingsPatch } from '../push/schemas';
import { AppError } from '../utils/AppError';
function latestChatId(profile: Partial<UserProfile>): string | null {
  const ids = profile.telegramChatIds ?? [];
  return ids.length ? String(ids[ids.length - 1]) : null;
}
export function notificationDefaults(
  profile: Partial<UserProfile>,
  now = Date.now(),
): NotificationSettings {
  return {
    ...normalizePushSettings(undefined, profile.timezone),
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
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) return;
    const data = snap.data as UserProfile;
    const patch: Record<string, unknown> = {};
    if (typeof data.createdAt !== 'number') patch.createdAt = data.updatedAt || Date.now();
    if (!data.notifications) patch.notifications = notificationDefaults(data);
    if (Object.keys(patch).length) {
      patch.updatedAt = Date.now();
      transaction.save(ref, patch, { merge: true });
    }
  });
}
async function cancelPending(uid: string, reason: string, includeCampaign = true): Promise<void> {
  while (true) {
    const snapshot = await readDocument(
      limitQuery(
        filterQuery(
          filterQuery(queryTable('notifications'), 'userId', '==', uid),
          'status',
          '==',
          'pending',
        ),
        400,
      ),
    );
    if (snapshot.empty) return;
    const cancellable = includeCampaign
      ? snapshot.rows
      : snapshot.rows.filter((document) => document.data.type !== 'campaign');
    if (!cancellable.length) return;
    const batch = writeBatch();
    const now = Date.now();
    cancellable.forEach((document) =>
      batch.save(
        document.key,
        {
          status: 'cancelled',
          skipReason: reason,
          leaseUntil: null,
          updatedAt: now,
        },
        { merge: true },
      ),
    );
    await batch.commit();
    if (snapshot.size < 400 || cancellable.length < snapshot.size) return;
  }
}
export async function patchNotificationSettings(
  uid: string,
  input: NotificationSettingsPatch,
): Promise<NotificationSettings> {
  const ref = profileRef(uid);
  const settings = await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) throw AppError.notFound('Profile not found.');
    const data = snap.data as UserProfile;
    const now = Date.now();
    const current = data.notifications ?? notificationDefaults(data, now);
    const normalized = normalizePushSettings(current, data.timezone);
    const next: NotificationSettings = {
      ...current,
      ...normalized,
      ...input,
      groups: { ...normalized.groups, ...input.groups },
      quietHours: { ...normalized.quietHours, ...input.quietHours },
    };
    // Read-only state is derived from the current device registry, never persisted.
    delete next.pushActive;
    if (input.enabled !== undefined) {
      next.nextDailyAt = input.enabled
        ? nextDailySlot(now, env.NOTIFY_DIGEST_HOUR, env.NOTIFY_TIMEZONE)
        : 0;
    }
    transaction.save(
      ref,
      {
        notifications: next,
        ...(input.timezone ? { timezone: input.timezone } : {}),
        updatedAt: now,
      },
      { merge: true },
    );
    return next;
  });
  if (input.enabled === false) await cancelPending(uid, 'disabled', false);
  return settings;
}
export async function setNotificationsEnabled(
  uid: string,
  enabled: boolean,
): Promise<NotificationSettings> {
  return patchNotificationSettings(uid, { enabled });
}
export async function markTelegramReachable(uid: string, chatId: string): Promise<void> {
  await ensureNotificationDefaults(uid);
  const now = Date.now();
  await patchDocument(profileRef(uid), {
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
  await patchDocument(profileRef(uid), {
    'notifications.telegram.status': status,
    'notifications.telegram.lastError': error.slice(0, 500),
    'notifications.telegram.checkedAt': now,
    updatedAt: now,
  });
  const { pushActive } = await import('../push/devices.repository');
  if (!(await pushActive(uid))) await cancelPending(uid, status);
}
