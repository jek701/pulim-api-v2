import { db } from '../config/firebase';
import { env } from '../config/env';
import type { Budget, Category, Subcategory, Transaction, UserProfile } from '../domain/types';
import { getProfile, profileRef } from '../repositories/profile.repository';
import { logger } from '../utils/logger';
import { collectBudgetAlerts } from './collectors/budget';
import { collectDaily } from './collectors/daily';
import {
  createNotification,
  failBudgetTask,
  finishBudgetTask,
  listDueBudgetTasks,
  profileCanReceive,
  recoverExpiredBudgetTasks,
  type BudgetTask,
} from './queue.repository';
import { dateKey, currentMonthRange, nextDailySlot } from './schedule';
import { getNotificationState } from './state.repository';

async function listOwned<T>(collection: string, uid: string): Promise<T[]> {
  const snapshot = await db.collection(collection).where('userId', '==', uid).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as T);
}

async function listMonthTransactions(uid: string, now: number): Promise<Transaction[]> {
  const range = currentMonthRange(now, env.NOTIFY_TIMEZONE);
  try {
    const snapshot = await db.collection('transactions')
      .where('userId', '==', uid)
      .where('date', '>=', range.start)
      .where('date', '<', range.end)
      .get();
    return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as Transaction);
  } catch (error) {
    logger.warn({ err: error, uid }, 'notify.budget.index_fallback');
    const rows = await listOwned<Transaction>('transactions', uid);
    return rows.filter((row) => row.date >= range.start && row.date < range.end);
  }
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, handler: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await handler(item);
    }
  }));
}

async function processProfile(
  document: FirebaseFirestore.QueryDocumentSnapshot,
  now: number,
): Promise<'queued' | 'skipped'> {
  const uid = document.id;
  const dueAt = Number(document.data().notifications?.nextDailyAt ?? now);
  const next = nextDailySlot(now, env.NOTIFY_DIGEST_HOUR, env.NOTIFY_TIMEZONE);
  await profileRef(uid).update({ 'notifications.nextDailyAt': next, updatedAt: now });
  const profile = { id: uid, ...document.data() } as UserProfile & { id: string };
  if (!profileCanReceive(profile)) return 'skipped';
  if (now > dueAt + env.NOTIFY_STALE_AFTER_MS) {
    logger.info({ uid, type: 'daily', skipReason: 'stale_slot' }, 'notify.skipped');
    return 'skipped';
  }
  const state = await getNotificationState(uid);
  const collected = await collectDaily({ uid, profile, state, now });
  if (!collected) return 'skipped';
  const queued = await createNotification({
    userId: uid,
    chatId: profile.notifications.telegram.chatId!,
    type: 'daily',
    dedupeKey: `daily:${uid}:${dateKey(now, env.NOTIFY_TIMEZONE)}`,
    runAt: dueAt,
    payload: collected.payload,
    stateKeys: collected.stateKeys,
    stateEffects: collected.stateEffects,
  });
  if (queued) logger.info({ uid, type: 'daily', blocks: collected.blockNames }, 'notify.queued.blocks');
  return queued ? 'queued' : 'skipped';
}

async function processBudgetTask(task: BudgetTask, now: number): Promise<number> {
  try {
    const profile = await getProfile(task.userId);
    if (!profileCanReceive(profile)) {
      await finishBudgetTask(task);
      return 0;
    }
    const [transactions, budgets, categories, subcategories, state] = await Promise.all([
      listMonthTransactions(task.userId, now),
      listOwned<Budget>('budgets', task.userId),
      listOwned<Category>('categories', task.userId),
      listOwned<Subcategory>('subcategories', task.userId),
      getNotificationState(task.userId),
    ]);
    const premium = profile.isPremium === true
      && typeof profile.subscription?.premiumUntil === 'number'
      && profile.subscription.premiumUntil > now;
    const alerts = collectBudgetAlerts({
      now, timeZone: env.NOTIFY_TIMEZONE, transactions, budgets, categories, subcategories, state, premium,
    });
    let queued = 0;
    for (const alert of alerts) {
      if (await createNotification({
        userId: task.userId,
        chatId: profile.notifications.telegram.chatId!,
        type: alert.payload.threshold === 100 ? 'budget_100' : 'budget_80',
        dedupeKey: alert.dedupeKey,
        payload: alert.payload,
        stateKeys: alert.stateKeys,
      })) queued += 1;
    }
    await finishBudgetTask(task);
    return queued;
  } catch (error) {
    await failBudgetTask(task, error);
    logger.error({ err: error, uid: task.userId }, 'notify.budget_task.failed');
    return 0;
  }
}

export async function runPlanner(now = Date.now()): Promise<{ scanned: number; queued: number; skipped: number }> {
  if (!env.NOTIFICATIONS_ENABLED) return { scanned: 0, queued: 0, skipped: 0 };
  const startedAt = Date.now();
  const recoveredTasks = await recoverExpiredBudgetTasks(now);
  if (recoveredTasks) logger.warn({ recoveredTasks }, 'notify.budget_tasks.recovered');
  const totals = { scanned: 0, queued: 0, skipped: 0 };
  for (let page = 0; page < 10; page += 1) {
    const snapshot = await db.collection('profiles')
      .where('notifications.nextDailyAt', '>', 0)
      .where('notifications.nextDailyAt', '<=', now)
      .orderBy('notifications.nextDailyAt')
      .limit(env.NOTIFY_PLANNER_BATCH)
      .get();
    if (snapshot.empty) break;
    totals.scanned += snapshot.size;
    await mapWithConcurrency(snapshot.docs, 5, async (document) => {
      try {
        const result = await processProfile(document, now);
        totals[result] += 1;
      } catch (error) {
        totals.skipped += 1;
        logger.error({ err: error, uid: document.id }, 'notify.planner.profile_failed');
      }
    });
    if (snapshot.size < env.NOTIFY_PLANNER_BATCH) break;
  }
  const tasks = await listDueBudgetTasks(now, 50);
  await mapWithConcurrency(tasks, 5, async (task) => {
    totals.queued += await processBudgetTask(task, now);
  });
  logger.info({ ...totals, durationMs: Date.now() - startedAt }, 'notify.planner.tick');
  return totals;
}
