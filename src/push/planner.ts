import { env, notificationRecipientAllowed } from '../config/env';
import { filterQuery, queryTable, readDocument } from '../db/documents';
import type { UserProfile } from '../domain/types';
import { getProfile } from '../repositories/profile.repository';
import { upsertScheduledNotification } from '../notifications/queue.repository';
import type { QueuedNotification } from '../notifications/types';
import { addLocalDays, dateKey, dayStart } from '../notifications/schedule';
import { logger } from '../utils/logger';
import { apnsConfigured } from './apns';
import { listPushUserIds } from './devices.repository';
import {
  collectScheduledPushes,
  refreshScheduledPush,
  type ScheduledPushSnapshot,
} from './scheduled';
import { normalizePushSettings } from './settings';

async function owned<T>(collection: string, uid: string): Promise<T[]> {
  const result = await readDocument(filterQuery(queryTable(collection), 'userId', '==', uid));
  return result.rows
    .filter((row) => row.data.scope !== 'household')
    .map((row) => ({ id: row.id, ...row.data }) as T);
}
export async function pushSnapshot(
  uid: string,
  profile: UserProfile,
  now: number,
): Promise<ScheduledPushSnapshot> {
  const timezone = normalizePushSettings(profile.notifications, profile.timezone).timezone;
  const start = addLocalDays(dayStart(now, timezone), -65, timezone);
  const [cards, subscriptions, debts, deposits, goals, categories, transactions] =
    await Promise.all([
      owned<NonNullable<ScheduledPushSnapshot['cards']>[number]>('cards', uid),
      owned<NonNullable<ScheduledPushSnapshot['subscriptions']>[number]>('subscriptions', uid),
      owned<NonNullable<ScheduledPushSnapshot['debts']>[number]>('debts', uid),
      owned<NonNullable<ScheduledPushSnapshot['deposits']>[number]>('deposits', uid),
      owned<NonNullable<ScheduledPushSnapshot['goals']>[number]>('savingsGoals', uid),
      owned<NonNullable<ScheduledPushSnapshot['categories']>[number]>('categories', uid),
      readDocument(
        filterQuery(
          filterQuery(queryTable('transactions'), 'userId', '==', uid),
          'date',
          '>=',
          start,
        ),
      ),
    ]);
  return {
    profile,
    now,
    timeZone: timezone,
    cards,
    subscriptions,
    debts,
    deposits,
    goals,
    categories,
    transactions: transactions.rows.map(
      (row) =>
        ({ id: row.id, ...row.data }) as NonNullable<ScheduledPushSnapshot['transactions']>[number],
    ),
  };
}
export async function runPushPlanner(now = Date.now()): Promise<number> {
  if (!env.NOTIFICATIONS_ENABLED || !apnsConfigured()) return 0;
  let queued = 0;
  let cursor: string | undefined;
  while (true) {
    const users = await listPushUserIds(cursor, env.NOTIFY_PLANNER_BATCH);
    for (const uid of users) {
      if (!notificationRecipientAllowed(uid)) continue;
      try {
        const profile = await getProfile(uid);
        if (!profile?.notifications?.enabled) continue;
        const settings = normalizePushSettings(profile.notifications, profile.timezone);
        const snapshot = await pushSnapshot(uid, profile, now);
        for (const candidate of collectScheduledPushes(snapshot)) {
          if (!settings.groups[candidate.group]) continue;
          const { runAt, dedupeKey, ...payload } = candidate;
          if (now > runAt + env.NOTIFY_STALE_AFTER_MS) continue;
          if (
            await upsertScheduledNotification({
              userId: uid,
              chatId: profile.notifications.telegram.chatId ?? '',
              type: candidate.type,
              runAt,
              dedupeKey: `${dedupeKey}:${uid}`,
              pushOnly: true,
              payload: { kind: 'push', ...payload },
            })
          )
            queued += 1;
        }
      } catch (error) {
        logger.error({ err: error, uid }, 'notify.push.plan_failed');
      }
    }
    if (users.length < env.NOTIFY_PLANNER_BATCH) break;
    cursor = users.at(-1);
  }
  return queued;
}
export async function scheduledStillRelevant(
  notification: QueuedNotification,
  profile: UserProfile,
  now: number,
): Promise<boolean> {
  if (notification.payload.kind !== 'push') return true;
  const timezone = normalizePushSettings(profile.notifications, profile.timezone).timezone;
  if (
    notification.payload.type === 'evening_log' &&
    dateKey(now, timezone) !== dateKey(notification.runAt, timezone)
  )
    return false;
  const snapshot = await pushSnapshot(notification.userId, profile, notification.runAt);
  const dedupeKey = notification.dedupeKey.slice(0, -(notification.userId.length + 1));
  const refreshed = refreshScheduledPush({ dedupeKey }, snapshot);
  if (!refreshed) return false;
  notification.payload.values = refreshed.values;
  return true;
}
