import {
  StoredDocument,
  Timestamp,
  documentKey,
  filterQuery,
  insertDocument,
  limitQuery,
  orderQuery,
  patchValue,
  queryTable,
  readDocument,
  runSqlTransaction,
  saveDocument,
} from '../db/documents';
import { createHash } from 'node:crypto';
import { env } from '../config/env';
import type { NotificationSettings, UserProfile } from '../domain/types';
import { getProfile, profileRef } from '../repositories/profile.repository';
import { logger } from '../utils/logger';
import { dateKey } from './schedule';
import { notificationStateRef, parseNotificationState, pruneSeen } from './state.repository';
import type {
  NotificationPayload,
  NotificationStateEffects,
  NotificationStatus,
  NotificationType,
  QueuedNotification,
  TrialStartedPayload,
} from './types';
const notificationCollection = () => queryTable('notifications');
const taskCollection = () => queryTable('notificationTasks');
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
function alreadyExists(error: unknown): boolean {
  const code = (
    error as {
      code?: number | string;
    }
  ).code;
  return code === 6 || code === 'already-exists';
}
export async function createNotification(input: {
  userId: string;
  chatId: string;
  type: NotificationType;
  dedupeKey: string;
  runAt?: number;
  payload: NotificationPayload;
  stateKeys?: string[];
  stateEffects?: NotificationStateEffects;
}): Promise<boolean> {
  const now = Date.now();
  const runAt = input.runAt ?? now;
  const ref = documentKey(notificationCollection(), digest(input.dedupeKey));
  try {
    await insertDocument(ref, {
      userId: input.userId,
      chatId: String(input.chatId),
      type: input.type,
      dedupeKey: input.dedupeKey,
      status: 'pending',
      runAt,
      staleAt: runAt + env.NOTIFY_STALE_AFTER_MS,
      deferredUntil: null,
      nextAttemptAt: runAt,
      leaseUntil: null,
      attempts: 0,
      lastError: null,
      skipReason: null,
      payload: input.payload,
      stateKeys: input.stateKeys ?? [],
      stateEffects: input.stateEffects ?? {},
      messageId: null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      expiresAt: Timestamp.fromMillis(now + 90 * 86400000),
    });
    logger.info(
      { uid: input.userId, type: input.type, dedupeKey: input.dedupeKey },
      'notify.queued',
    );
    return true;
  } catch (error) {
    if (alreadyExists(error)) return false;
    throw error;
  }
}
export async function queueTrialStarted(uid: string): Promise<boolean> {
  if (!env.NOTIFICATIONS_ENABLED) return false;
  const profile = await getProfile(uid);
  const settings = profile?.notifications;
  const premiumUntil = profile?.subscription?.premiumUntil;
  if (!settings?.enabled || !settings.telegram.chatId || typeof premiumUntil !== 'number')
    return false;
  if (settings.telegram.status === 'blocked' || settings.telegram.status === 'unreachable')
    return false;
  const payload: TrialStartedPayload = { kind: 'trial_started', premiumUntil };
  return createNotification({
    userId: uid,
    chatId: settings.telegram.chatId,
    type: 'trial_started',
    dedupeKey: `trial_started:${uid}`,
    payload,
    stateKeys: [`trial_started:${uid}`],
  });
}
export async function scheduleBudgetCheck(uid: string): Promise<void> {
  if (!env.NOTIFICATIONS_ENABLED) return;
  const ref = documentKey(taskCollection(), digest(`budget_check:${uid}`));
  const now = Date.now();
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    const data = snap.data;
    const version = Number(data?.version ?? 0) + 1;
    if (data?.status === 'processing' && Number(data.leaseUntil ?? 0) > now) {
      transaction.save(
        ref,
        {
          version,
          rerunAt: now + env.NOTIFY_BUDGET_DEBOUNCE_MS,
          updatedAt: now,
          expiresAt: Timestamp.fromMillis(now + 90 * 86400000),
        },
        { merge: true },
      );
      return;
    }
    transaction.save(
      ref,
      {
        userId: uid,
        type: 'budget_check',
        status: 'pending',
        version,
        runAt: now + env.NOTIFY_BUDGET_DEBOUNCE_MS,
        rerunAt: null,
        leaseUntil: null,
        createdAt: Number(data?.createdAt ?? now),
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(now + 90 * 86400000),
      },
      { merge: true },
    );
  });
}
export interface BudgetTask {
  id: string;
  userId: string;
  version: number;
}
export async function listDueBudgetTasks(now: number, limit = 50): Promise<BudgetTask[]> {
  const snapshot = await readDocument(
    limitQuery(
      orderQuery(
        filterQuery(filterQuery(taskCollection(), 'status', '==', 'pending'), 'runAt', '<=', now),
        'runAt',
      ),
      limit,
    ),
  );
  const tasks: BudgetTask[] = [];
  for (const document of snapshot.rows) {
    const claimed = await runSqlTransaction(async (transaction) => {
      const snap = await transaction.read(document.key);
      const data = snap.data;
      if (!data || data.status !== 'pending' || Number(data.runAt) > now) return null;
      const version = Number(data.version ?? 0);
      transaction.save(
        document.key,
        {
          status: 'processing',
          claimedVersion: version,
          leaseUntil: now + env.NOTIFY_LEASE_MS,
          updatedAt: now,
        },
        { merge: true },
      );
      return { id: document.id, userId: String(data.userId), version };
    });
    if (claimed) tasks.push(claimed);
  }
  return tasks;
}
export async function finishBudgetTask(task: BudgetTask): Promise<void> {
  const ref = documentKey(taskCollection(), task.id);
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) return;
    const data = snap.data!;
    const now = Date.now();
    if (Number(data.version ?? 0) > task.version) {
      transaction.save(
        ref,
        {
          status: 'pending',
          runAt: Number(data.rerunAt ?? now + env.NOTIFY_BUDGET_DEBOUNCE_MS),
          rerunAt: null,
          leaseUntil: null,
          updatedAt: now,
        },
        { merge: true },
      );
    } else {
      transaction.save(ref, { status: 'done', leaseUntil: null, updatedAt: now }, { merge: true });
    }
  });
}
export async function recoverExpiredBudgetTasks(now = Date.now()): Promise<number> {
  const snapshot = await readDocument(
    limitQuery(
      orderQuery(
        filterQuery(
          filterQuery(taskCollection(), 'status', '==', 'processing'),
          'leaseUntil',
          '<=',
          now,
        ),
        'leaseUntil',
      ),
      100,
    ),
  );
  if (snapshot.empty) return 0;
  let recovered = 0;
  for (const document of snapshot.rows) {
    const changed = await runSqlTransaction(async (transaction) => {
      const snap = await transaction.read(document.key);
      const data = snap.data;
      if (!data || data.status !== 'processing' || Number(data.leaseUntil ?? 0) > now) return false;
      const hasNewerVersion = Number(data.version ?? 0) > Number(data.claimedVersion ?? 0);
      transaction.save(
        document.key,
        {
          status: 'pending',
          runAt: hasNewerVersion ? Math.max(now, Number(data.rerunAt ?? now)) : now,
          rerunAt: null,
          leaseUntil: null,
          lastError: 'lease_lost',
          updatedAt: now,
        },
        { merge: true },
      );
      return true;
    });
    if (changed) recovered += 1;
  }
  return recovered;
}
export async function failBudgetTask(task: BudgetTask, error: unknown): Promise<void> {
  const ref = documentKey(taskCollection(), task.id);
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) return;
    const data = snap.data!;
    const now = Date.now();
    const hasNewerVersion = Number(data.version ?? 0) > task.version;
    transaction.save(
      ref,
      {
        status: 'pending',
        runAt: hasNewerVersion
          ? Math.max(now, Number(data.rerunAt ?? now + env.NOTIFY_BUDGET_DEBOUNCE_MS))
          : now + 60000,
        rerunAt: null,
        leaseUntil: null,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        updatedAt: now,
      },
      { merge: true },
    );
  });
}
function toQueued(document: StoredDocument): QueuedNotification {
  return { id: document.id, ...document.data } as QueuedNotification;
}
export async function listDueNotifications(
  now: number,
  limit: number,
): Promise<QueuedNotification[]> {
  const snapshot = await readDocument(
    limitQuery(
      orderQuery(
        filterQuery(
          filterQuery(notificationCollection(), 'status', '==', 'pending'),
          'nextAttemptAt',
          '<=',
          now,
        ),
        'nextAttemptAt',
      ),
      limit,
    ),
  );
  return snapshot.rows.map(toQueued);
}
export async function claimNotification(
  id: string,
  now: number,
): Promise<QueuedNotification | null> {
  const ref = documentKey(notificationCollection(), id);
  return runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) return null;
    const data = snap.data!;
    if (data.status !== 'pending' || Number(data.nextAttemptAt) > now) return null;
    transaction.save(
      ref,
      {
        status: 'sending',
        attempts: Number(data.attempts ?? 0) + 1,
        leaseUntil: now + env.NOTIFY_LEASE_MS,
        updatedAt: now,
      },
      { merge: true },
    );
    return {
      id: snap.id,
      ...data,
      status: 'sending',
      attempts: Number(data.attempts ?? 0) + 1,
      leaseUntil: now + env.NOTIFY_LEASE_MS,
    } as QueuedNotification;
  });
}
export async function deferNotification(id: string, until: number): Promise<void> {
  await saveDocument(
    documentKey(notificationCollection(), id),
    {
      status: 'pending',
      deferredUntil: until,
      nextAttemptAt: until,
      staleAt: until + env.NOTIFY_STALE_AFTER_MS,
      leaseUntil: null,
      attempts: patchValue.increment(-1),
      updatedAt: Date.now(),
    },
    { merge: true },
  );
}
export async function retryNotification(
  id: string,
  nextAttemptAt: number,
  error: string,
  undoAttempt = false,
): Promise<void> {
  await saveDocument(
    documentKey(notificationCollection(), id),
    {
      status: 'pending',
      nextAttemptAt,
      leaseUntil: null,
      lastError: error.slice(0, 500),
      ...(undoAttempt ? { attempts: patchValue.increment(-1) } : {}),
      updatedAt: Date.now(),
    },
    { merge: true },
  );
}
export async function finishNotification(
  id: string,
  status: Exclude<NotificationStatus, 'pending' | 'sending' | 'sent'>,
  reason: string,
): Promise<void> {
  await saveDocument(
    documentKey(notificationCollection(), id),
    {
      status,
      skipReason: status === 'skipped' || status === 'cancelled' ? reason : null,
      lastError: status === 'failed' ? reason.slice(0, 500) : null,
      leaseUntil: null,
      updatedAt: Date.now(),
    },
    { merge: true },
  );
}
export async function reserveSafetySlot(
  uid: string,
  now: number,
  allowReminderDisabled = false,
): Promise<'ok' | 'disabled' | 'cap'> {
  const ref = profileRef(uid);
  const today = dateKey(now, env.NOTIFY_TIMEZONE);
  return runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    const settings = snap.data?.notifications as NotificationSettings | undefined;
    if (
      !settings ||
      (!allowReminderDisabled && !settings.enabled) ||
      settings.telegram.status === 'blocked' ||
      settings.telegram.status === 'unreachable'
    ) {
      return 'disabled';
    }
    const sent = settings.sentDay === today ? Number(settings.sentCount ?? 0) : 0;
    const reserved = settings.reservedDay === today ? Number(settings.reservedCount ?? 0) : 0;
    if (sent + reserved >= env.NOTIFY_SAFETY_MAX_PER_USER_PER_DAY) return 'cap';
    transaction.patch(ref, {
      'notifications.sentDay': today,
      'notifications.sentCount': sent,
      'notifications.reservedDay': today,
      'notifications.reservedCount': reserved + 1,
      updatedAt: now,
    });
    return 'ok';
  });
}
export async function releaseSafetySlot(uid: string, now = Date.now()): Promise<void> {
  const today = dateKey(now, env.NOTIFY_TIMEZONE);
  await runSqlTransaction(async (transaction) => {
    const ref = profileRef(uid);
    const snap = await transaction.read(ref);
    const settings = snap.data?.notifications as NotificationSettings | undefined;
    if (!settings || settings.reservedDay !== today || Number(settings.reservedCount ?? 0) <= 0)
      return;
    transaction.patch(ref, {
      'notifications.reservedCount': Number(settings.reservedCount) - 1,
      updatedAt: now,
    });
  });
}
export async function markNotificationSent(
  notification: QueuedNotification,
  messageId: number,
  introWasIncluded: boolean,
  now = Date.now(),
): Promise<void> {
  const notificationRef = documentKey(notificationCollection(), notification.id);
  const userProfileRef = profileRef(notification.userId);
  const stateRef = notificationStateRef(notification.userId);
  const today = dateKey(now, env.NOTIFY_TIMEZONE);
  await runSqlTransaction(async (transaction) => {
    const [jobSnap, profileSnap, stateSnap] = await Promise.all([
      transaction.read(notificationRef),
      transaction.read(userProfileRef),
      transaction.read(stateRef),
    ]);
    if (!jobSnap.exists) return;
    const job = jobSnap.data!;
    const recoverableLeaseFailure =
      job.status === 'failed' && job.lastError === 'lease_lost' && !job.sentAt;
    if (job.status !== 'sending' && !recoverableLeaseFailure) return;
    const settings = profileSnap.data?.notifications as NotificationSettings | undefined;
    const state = parseNotificationState(notification.userId, stateSnap.data);
    const seen = pruneSeen(state.seen, now);
    notification.stateKeys.forEach((key) => {
      seen[key] = now;
    });
    const effects = notification.stateEffects ?? {};
    const statePatch = {
      userId: notification.userId,
      seen,
      trialAvailableSentCount: state.trialAvailableSentCount + (effects.trialAvailableSent ? 1 : 0),
      lastTrialAvailableAt: effects.trialAvailableSent ? now : state.lastTrialAvailableAt,
      weeklyEmptyStreak: effects.weeklyEmpty
        ? state.weeklyEmptyStreak + 1
        : effects.weeklyActive
          ? 0
          : state.weeklyEmptyStreak,
      updatedAt: now,
    };
    const sent = settings?.sentDay === today ? Number(settings.sentCount ?? 0) : 0;
    const reserved = settings?.reservedDay === today ? Number(settings.reservedCount ?? 0) : 0;
    transaction.save(
      notificationRef,
      {
        status: 'sent',
        messageId,
        sentAt: now,
        leaseUntil: null,
        lastError: null,
        updatedAt: now,
      },
      { merge: true },
    );
    transaction.patch(userProfileRef, {
      'notifications.sentDay': today,
      'notifications.sentCount': sent + 1,
      'notifications.reservedDay': today,
      'notifications.reservedCount': Math.max(0, reserved - 1),
      'notifications.lastSentAt': now,
      'notifications.telegram.status': 'reachable',
      'notifications.telegram.lastError': null,
      'notifications.telegram.checkedAt': now,
      ...(introWasIncluded ? { 'notifications.introSentAt': now } : {}),
      updatedAt: now,
    });
    transaction.save(stateRef, statePatch);
  });
}
export async function recoverExpiredLeases(now = Date.now()): Promise<number> {
  const snapshot = await readDocument(
    limitQuery(
      orderQuery(
        filterQuery(
          filterQuery(notificationCollection(), 'status', '==', 'sending'),
          'leaseUntil',
          '<=',
          now,
        ),
        'leaseUntil',
      ),
      100,
    ),
  );
  if (snapshot.empty) return 0;
  let recovered = 0;
  for (const document of snapshot.rows) {
    const changed = await runSqlTransaction(async (transaction) => {
      const snap = await transaction.read(document.key);
      const data = snap.data;
      if (!data || data.status !== 'sending' || Number(data.leaseUntil ?? 0) > now) return false;
      transaction.save(
        document.key,
        {
          status: 'failed',
          lastError: 'lease_lost',
          leaseUntil: null,
          updatedAt: now,
        },
        { merge: true },
      );
      return true;
    });
    if (changed) recovered += 1;
  }
  return recovered;
}
export async function recordDeliveryStat(
  sent: boolean,
  forbidden: boolean,
  now = Date.now(),
): Promise<void> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.NOTIFY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const id = `${values.year}-${values.month}-${values.day}-${values.hour}`;
  const ref = documentKey(queryTable('notificationStats'), id);
  await saveDocument(
    ref,
    {
      sent: patchValue.increment(sent ? 1 : 0),
      forbidden: patchValue.increment(forbidden ? 1 : 0),
      attempts: patchValue.increment(1),
      updatedAt: now,
    },
    { merge: true },
  );
  if (forbidden) {
    const snap = await readDocument(ref);
    const attempts = Number(snap.data?.attempts ?? 0);
    const count = Number(snap.data?.forbidden ?? 0);
    if (attempts >= 10 && count / attempts > 0.05) {
      logger.error({ attempts, forbidden: count, hour: id }, 'notify.telegram_forbidden_rate_high');
    }
  }
}
export function notificationRef(id: string) {
  return documentKey(notificationCollection(), id);
}
export function profileCanReceive(
  profile:
    | (UserProfile & {
        id: string;
      })
    | null,
): profile is UserProfile & {
  id: string;
  notifications: NotificationSettings;
} {
  const settings = profile?.notifications;
  return Boolean(
    settings?.enabled &&
    settings.telegram.chatId &&
    settings.telegram.status !== 'blocked' &&
    settings.telegram.status !== 'unreachable',
  );
}
