import { createHash } from 'node:crypto';
import { db, FieldValue, Timestamp } from '../config/firebase';
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

const notificationCollection = () => db.collection('notifications');
const taskCollection = () => db.collection('notificationTasks');

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function alreadyExists(error: unknown): boolean {
  const code = (error as { code?: number | string }).code;
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
  const ref = notificationCollection().doc(digest(input.dedupeKey));
  try {
    await ref.create({
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
      expiresAt: Timestamp.fromMillis(now + 90 * 86_400_000),
    });
    logger.info({ uid: input.userId, type: input.type, dedupeKey: input.dedupeKey }, 'notify.queued');
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
  if (!settings?.enabled || !settings.telegram.chatId || typeof premiumUntil !== 'number') return false;
  if (settings.telegram.status === 'blocked' || settings.telegram.status === 'unreachable') return false;
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
  const ref = taskCollection().doc(digest(`budget_check:${uid}`));
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.data();
    const version = Number(data?.version ?? 0) + 1;
    if (data?.status === 'processing' && Number(data.leaseUntil ?? 0) > now) {
      transaction.set(ref, {
        version,
        rerunAt: now + env.NOTIFY_BUDGET_DEBOUNCE_MS,
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(now + 90 * 86_400_000),
      }, { merge: true });
      return;
    }
    transaction.set(ref, {
      userId: uid,
      type: 'budget_check',
      status: 'pending',
      version,
      runAt: now + env.NOTIFY_BUDGET_DEBOUNCE_MS,
      rerunAt: null,
      leaseUntil: null,
      createdAt: Number(data?.createdAt ?? now),
      updatedAt: now,
      expiresAt: Timestamp.fromMillis(now + 90 * 86_400_000),
    }, { merge: true });
  });
}

export interface BudgetTask {
  id: string;
  userId: string;
  version: number;
}

export async function listDueBudgetTasks(now: number, limit = 50): Promise<BudgetTask[]> {
  const snapshot = await taskCollection()
    .where('status', '==', 'pending')
    .where('runAt', '<=', now)
    .orderBy('runAt')
    .limit(limit)
    .get();
  const tasks: BudgetTask[] = [];
  for (const document of snapshot.docs) {
    const claimed = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(document.ref);
      const data = snap.data();
      if (!data || data.status !== 'pending' || Number(data.runAt) > now) return null;
      const version = Number(data.version ?? 0);
      transaction.set(document.ref, {
        status: 'processing', claimedVersion: version, leaseUntil: now + env.NOTIFY_LEASE_MS, updatedAt: now,
      }, { merge: true });
      return { id: document.id, userId: String(data.userId), version };
    });
    if (claimed) tasks.push(claimed);
  }
  return tasks;
}

export async function finishBudgetTask(task: BudgetTask): Promise<void> {
  const ref = taskCollection().doc(task.id);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const data = snap.data()!;
    const now = Date.now();
    if (Number(data.version ?? 0) > task.version) {
      transaction.set(ref, {
        status: 'pending',
        runAt: Number(data.rerunAt ?? now + env.NOTIFY_BUDGET_DEBOUNCE_MS),
        rerunAt: null,
        leaseUntil: null,
        updatedAt: now,
      }, { merge: true });
    } else {
      transaction.set(ref, { status: 'done', leaseUntil: null, updatedAt: now }, { merge: true });
    }
  });
}

export async function recoverExpiredBudgetTasks(now = Date.now()): Promise<number> {
  const snapshot = await taskCollection()
    .where('status', '==', 'processing')
    .where('leaseUntil', '<=', now)
    .orderBy('leaseUntil')
    .limit(100)
    .get();
  if (snapshot.empty) return 0;
  let recovered = 0;
  for (const document of snapshot.docs) {
    const changed = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(document.ref);
      const data = snap.data();
      if (!data || data.status !== 'processing' || Number(data.leaseUntil ?? 0) > now) return false;
      const hasNewerVersion = Number(data.version ?? 0) > Number(data.claimedVersion ?? 0);
      transaction.set(document.ref, {
        status: 'pending',
        runAt: hasNewerVersion ? Math.max(now, Number(data.rerunAt ?? now)) : now,
        rerunAt: null,
        leaseUntil: null,
        lastError: 'lease_lost',
        updatedAt: now,
      }, { merge: true });
      return true;
    });
    if (changed) recovered += 1;
  }
  return recovered;
}

export async function failBudgetTask(task: BudgetTask, error: unknown): Promise<void> {
  const ref = taskCollection().doc(task.id);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const data = snap.data()!;
    const now = Date.now();
    const hasNewerVersion = Number(data.version ?? 0) > task.version;
    transaction.set(ref, {
      status: 'pending',
      runAt: hasNewerVersion
        ? Math.max(now, Number(data.rerunAt ?? now + env.NOTIFY_BUDGET_DEBOUNCE_MS))
        : now + 60_000,
      rerunAt: null,
      leaseUntil: null,
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      updatedAt: now,
    }, { merge: true });
  });
}

function toQueued(document: FirebaseFirestore.QueryDocumentSnapshot): QueuedNotification {
  return { id: document.id, ...document.data() } as QueuedNotification;
}

export async function listDueNotifications(now: number, limit: number): Promise<QueuedNotification[]> {
  const snapshot = await notificationCollection()
    .where('status', '==', 'pending')
    .where('nextAttemptAt', '<=', now)
    .orderBy('nextAttemptAt')
    .limit(limit)
    .get();
  return snapshot.docs.map(toQueued);
}

export async function claimNotification(id: string, now: number): Promise<QueuedNotification | null> {
  const ref = notificationCollection().doc(id);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return null;
    const data = snap.data()!;
    if (data.status !== 'pending' || Number(data.nextAttemptAt) > now) return null;
    transaction.set(ref, {
      status: 'sending',
      attempts: Number(data.attempts ?? 0) + 1,
      leaseUntil: now + env.NOTIFY_LEASE_MS,
      updatedAt: now,
    }, { merge: true });
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
  await notificationCollection().doc(id).set({
    status: 'pending',
    deferredUntil: until,
    nextAttemptAt: until,
    staleAt: until + env.NOTIFY_STALE_AFTER_MS,
    leaseUntil: null,
    attempts: FieldValue.increment(-1),
    updatedAt: Date.now(),
  }, { merge: true });
}

export async function retryNotification(
  id: string,
  nextAttemptAt: number,
  error: string,
  undoAttempt = false,
): Promise<void> {
  await notificationCollection().doc(id).set({
    status: 'pending',
    nextAttemptAt,
    leaseUntil: null,
    lastError: error.slice(0, 500),
    ...(undoAttempt ? { attempts: FieldValue.increment(-1) } : {}),
    updatedAt: Date.now(),
  }, { merge: true });
}

export async function finishNotification(
  id: string,
  status: Exclude<NotificationStatus, 'pending' | 'sending' | 'sent'>,
  reason: string,
): Promise<void> {
  await notificationCollection().doc(id).set({
    status,
    skipReason: status === 'skipped' || status === 'cancelled' ? reason : null,
    lastError: status === 'failed' ? reason.slice(0, 500) : null,
    leaseUntil: null,
    updatedAt: Date.now(),
  }, { merge: true });
}

export async function reserveSafetySlot(uid: string, now: number, allowReminderDisabled = false): Promise<'ok' | 'disabled' | 'cap'> {
  const ref = profileRef(uid);
  const today = dateKey(now, env.NOTIFY_TIMEZONE);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const settings = snap.data()?.notifications as NotificationSettings | undefined;
    if (!settings || (!allowReminderDisabled && !settings.enabled) || settings.telegram.status === 'blocked' || settings.telegram.status === 'unreachable') {
      return 'disabled';
    }
    const sent = settings.sentDay === today ? Number(settings.sentCount ?? 0) : 0;
    const reserved = settings.reservedDay === today ? Number(settings.reservedCount ?? 0) : 0;
    if (sent + reserved >= env.NOTIFY_SAFETY_MAX_PER_USER_PER_DAY) return 'cap';
    transaction.update(ref, {
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
  await db.runTransaction(async (transaction) => {
    const ref = profileRef(uid);
    const snap = await transaction.get(ref);
    const settings = snap.data()?.notifications as NotificationSettings | undefined;
    if (!settings || settings.reservedDay !== today || Number(settings.reservedCount ?? 0) <= 0) return;
    transaction.update(ref, {
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
  const notificationRef = notificationCollection().doc(notification.id);
  const userProfileRef = profileRef(notification.userId);
  const stateRef = notificationStateRef(notification.userId);
  const today = dateKey(now, env.NOTIFY_TIMEZONE);
  await db.runTransaction(async (transaction) => {
    const [jobSnap, profileSnap, stateSnap] = await Promise.all([
      transaction.get(notificationRef),
      transaction.get(userProfileRef),
      transaction.get(stateRef),
    ]);
    if (!jobSnap.exists) return;
    const job = jobSnap.data()!;
    const recoverableLeaseFailure = job.status === 'failed'
      && job.lastError === 'lease_lost'
      && !job.sentAt;
    if (job.status !== 'sending' && !recoverableLeaseFailure) return;
    const settings = profileSnap.data()?.notifications as NotificationSettings | undefined;
    const state = parseNotificationState(notification.userId, stateSnap.data());
    const seen = pruneSeen(state.seen, now);
    notification.stateKeys.forEach((key) => { seen[key] = now; });
    const effects = notification.stateEffects ?? {};
    const statePatch = {
      userId: notification.userId,
      seen,
      trialAvailableSentCount: state.trialAvailableSentCount + (effects.trialAvailableSent ? 1 : 0),
      lastTrialAvailableAt: effects.trialAvailableSent ? now : state.lastTrialAvailableAt,
      weeklyEmptyStreak: effects.weeklyEmpty
        ? state.weeklyEmptyStreak + 1
        : effects.weeklyActive ? 0 : state.weeklyEmptyStreak,
      updatedAt: now,
    };
    const sent = settings?.sentDay === today ? Number(settings.sentCount ?? 0) : 0;
    const reserved = settings?.reservedDay === today ? Number(settings.reservedCount ?? 0) : 0;
    transaction.set(notificationRef, {
      status: 'sent', messageId, sentAt: now, leaseUntil: null, lastError: null, updatedAt: now,
    }, { merge: true });
    transaction.update(userProfileRef, {
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
    transaction.set(stateRef, statePatch);
  });
}

export async function recoverExpiredLeases(now = Date.now()): Promise<number> {
  const snapshot = await notificationCollection()
    .where('status', '==', 'sending')
    .where('leaseUntil', '<=', now)
    .orderBy('leaseUntil')
    .limit(100)
    .get();
  if (snapshot.empty) return 0;
  let recovered = 0;
  for (const document of snapshot.docs) {
    const changed = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(document.ref);
      const data = snap.data();
      if (!data || data.status !== 'sending' || Number(data.leaseUntil ?? 0) > now) return false;
      transaction.set(document.ref, {
        status: 'failed', lastError: 'lease_lost', leaseUntil: null, updatedAt: now,
      }, { merge: true });
      return true;
    });
    if (changed) recovered += 1;
  }
  return recovered;
}

export async function recordDeliveryStat(sent: boolean, forbidden: boolean, now = Date.now()): Promise<void> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.NOTIFY_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const id = `${values.year}-${values.month}-${values.day}-${values.hour}`;
  const ref = db.collection('notificationStats').doc(id);
  await ref.set({
    sent: FieldValue.increment(sent ? 1 : 0),
    forbidden: FieldValue.increment(forbidden ? 1 : 0),
    attempts: FieldValue.increment(1),
    updatedAt: now,
  }, { merge: true });
  if (forbidden) {
    const snap = await ref.get();
    const attempts = Number(snap.data()?.attempts ?? 0);
    const count = Number(snap.data()?.forbidden ?? 0);
    if (attempts >= 10 && count / attempts > 0.05) {
      logger.error({ attempts, forbidden: count, hour: id }, 'notify.telegram_forbidden_rate_high');
    }
  }
}

export function notificationRef(id: string) {
  return notificationCollection().doc(id);
}

export function profileCanReceive(profile: (UserProfile & { id: string }) | null): profile is UserProfile & { id: string; notifications: NotificationSettings } {
  const settings = profile?.notifications;
  return Boolean(settings?.enabled
    && settings.telegram.chatId
    && settings.telegram.status !== 'blocked'
    && settings.telegram.status !== 'unreachable');
}
