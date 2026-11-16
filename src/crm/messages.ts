import { database } from '../db/database';
import { decodeData } from '../db/values';
import { createHash } from 'node:crypto';
import { env, notificationRecipientAllowed } from '../config/env';
import {
  documentKey,
  queryTable,
  runSqlTransaction,
  readDocument,
  Timestamp,
} from '../db/documents';
import { profileRef } from '../repositories/profile.repository';
import { enabledDevices } from '../push/devices.repository';
import { normalizePushSettings } from '../push/settings';
import { quietHoursUntil } from '../push/routing';
import { queuedNotificationData } from '../notifications/queue.repository';
import { notificationDefaults } from '../notifications/settings';
import { dateKey } from '../notifications/schedule';
import type { UserProfile } from '../domain/types';
import { registeredProfile } from './facts';
import type { CrmMessage } from './schemas';

export const crmMessageKey = (mid: string) =>
  `crm:${createHash('sha256').update(mid).digest('hex')}`;
export type CrmOutcome = { status: 'queued' | 'skipped'; reason: string | null };
export function crmSkipReason(
  profile: UserProfile | null,
  active: boolean,
  category: CrmMessage['category'],
  now: number,
  deliveryAt = now,
): string | null {
  if (!registeredProfile(profile)) return 'unknown_user';
  if (!active) return 'no_device';
  const settings = normalizePushSettings(profile.notifications, profile.timezone);
  if (!settings.enabled || (category === 'marketing' && settings.groups.tips !== true))
    return 'opted_out';
  const state = profile.notifications;
  const today = dateKey(now, settings.timezone);
  const used =
    (state?.sentDay === today ? Number(state.sentCount ?? 0) : 0) +
    (state?.reservedDay === today ? Number(state.reservedCount ?? 0) : 0);
  if (
    used >= Math.min(6, env.NOTIFY_SAFETY_MAX_PER_USER_PER_DAY) ||
    (category === 'marketing' &&
      [
        state?.crmMarketingQueuedDay,
        state?.crmMarketingSentDay,
        state?.crmMarketingReservedDay,
      ].includes(dateKey(deliveryAt, settings.timezone)))
  )
    return 'daily_cap';
  return null;
}
export async function queueCrmMessage(input: CrmMessage): Promise<CrmOutcome> {
  const ref = documentKey(queryTable('notifications'), crmMessageKey(input.mid));
  // Avoid re-reading devices for a normal repeat; recheck outcome under the effect lock below.
  const previous = await readDocument(ref);
  if (previous.exists) return previous.data.crmOutcome as CrmOutcome;
  const active = (await enabledDevices(input.uid)).length > 0;
  return runSqlTransaction(async (tx) => {
    // Same lock order as delivery acknowledgement: job, then profile.
    const job = await tx.read(ref);
    const profile = await tx.read(profileRef(input.uid));
    if (job.exists) return job.data.crmOutcome as CrmOutcome;
    const now = Date.now();
    const preferences = normalizePushSettings(profile.data?.notifications, profile.data?.timezone);
    const runAt = quietHoursUntil(now, preferences.timezone, preferences.quietHours) ?? now;
    let reason = crmSkipReason(
      profile.exists ? (profile.data as UserProfile) : null,
      active,
      input.category,
      now,
      runAt,
    );
    if (
      !reason &&
      (!env.NOTIFICATIONS_ENABLED || !env.PUSH_ENABLED || !notificationRecipientAllowed(input.uid))
    )
      reason = 'disabled';
    const staleAt = now + input.ttlSec * 1000;
    if (!reason && runAt >= staleAt) reason = 'expired';
    const outcome: CrmOutcome = { status: reason ? 'skipped' : 'queued', reason };
    if (reason) {
      // A late CRM request must not recreate personal data after account deletion.
      tx.insert(ref, {
        ...(registeredProfile(profile.data as UserProfile) ? { userId: input.uid } : {}),
        type: 'crm',
        status: 'skipped',
        skipReason: reason,
        crmOutcome: outcome,
        createdAt: now,
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(now + 90 * 86400000),
      });
      return outcome;
    }
    tx.insert(ref, {
      ...queuedNotificationData(
        {
          userId: input.uid,
          chatId: '',
          type: 'crm',
          dedupeKey: ref.id,
          runAt,
          pushOnly: true,
          payload: {
            kind: 'push',
            type: 'crm',
            group: 'tips',
            link: input.link,
            values: {},
            eventAt: now,
            crm: {
              mid: input.mid,
              category: input.category,
              title: input.title,
              body: input.body,
              ...(input.collapseKey ? { collapseKey: input.collapseKey } : {}),
            },
          },
        },
        now,
      ),
      staleAt,
      status: 'pending',
      skipReason: null,
      crmOutcome: outcome,
    });
    if (!reason && !profile.data.notifications)
      tx.patch(profileRef(input.uid), {
        notifications: notificationDefaults(profile.data, now),
        updatedAt: now,
      });
    if (!reason && input.category === 'marketing')
      tx.patch(profileRef(input.uid), {
        'notifications.crmMarketingQueuedDay': dateKey(runAt, preferences.timezone),
        updatedAt: now,
      });
    return outcome;
  });
}
export function crmStatus(mid: string, data?: Record<string, any>) {
  if (!data) return { mid, status: 'unknown' as const, reason: null, at: null };
  const status =
    data.status === 'pending' || data.status === 'sending'
      ? 'queued'
      : data.status === 'cancelled'
        ? 'skipped'
        : data.status;
  return {
    mid,
    status,
    reason: data.skipReason ?? (data.status === 'failed' ? 'delivery_failed' : null),
    at: data.sentAt ?? data.updatedAt ?? data.createdAt,
  };
}
export async function crmMessageStatuses(mids: string[]) {
  const rows = await database()
    .selectFrom('notifications')
    .select(['id', 'data_json', 'types_json'])
    .where(
      'id',
      'in',
      [...new Set(mids.map(crmMessageKey))].map((key) => Buffer.from(key)),
    )
    .execute();
  const byKey = new Map(
    rows.map((row) => [String(row.id), decodeData(row.data_json, row.types_json)]),
  );
  return { messages: mids.map((mid) => crmStatus(mid, byKey.get(crmMessageKey(mid)))) };
}
