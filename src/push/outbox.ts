import { kickPushPlanning } from './kick';
import type { Kysely, Transaction } from 'kysely';
import { env, notificationRecipientAllowed } from '../config/env';
import { documentKey, insertDocumentIfAbsent, queryTable, SqlTransaction, Timestamp } from '../db/documents';
import { relationalTables } from '../db/tables';
import {
  armBudgetCheck,
  notificationId,
  queuedNotificationData,
  PUSH_BUDGET_DEBOUNCE_MS,
} from '../notifications/queue.repository';
import { immediateEvents, type WriteChange } from './events';

/** Runs on the effect transaction's connection. External delivery only happens after commit. */
export async function enqueueWriteEvents(
  executor: Kysely<any> | Transaction<any>,
  changes: WriteChange[],
  afterCommit?: (callback: () => void) => void,
): Promise<boolean> {
  if (!env.NOTIFICATIONS_ENABLED || !env.PUSH_ENABLED) return false;
  const now = Date.now();
  const events = changes.flatMap((change) => immediateEvents(change, now));
  const budgets = new Map<string, { uid: string; categoryId: string }>();
  for (const change of changes) {
    if (change.key.table !== 'transactions') continue;
    for (const data of [change.before, change.after]) {
      if (
        !data?.userId ||
        !data.categoryId ||
        data.scope === 'household' ||
        data.source === 'transfer' ||
        !notificationRecipientAllowed(data.userId)
      )
        continue;
      budgets.set(`${data.userId}:${data.categoryId}`, {
        uid: data.userId,
        categoryId: data.categoryId,
      });
    }
  }
  const planningUids = new Set<string>();
  for (const { key, before, after } of changes) {
    let uid = after.userId ?? before?.userId;
    if (key.table === 'profiles') {
      const fields = (data?: Record<string, any>) =>
        JSON.stringify([
          data?.language,
          data?.timezone,
          data?.notifications?.timezone,
          data?.notifications?.enabled,
          data?.notifications?.groups,
          data?.notifications?.quietHours,
          data?.subscription?.premiumUntil,
          data?.subscription?.isTrial,
        ]);
      if (fields(before) === fields(after)) continue;
      uid = key.id;
    }
    if (
      uid &&
      after.scope !== 'household' &&
      before?.scope !== 'household' &&
      notificationRecipientAllowed(uid)
    )
      planningUids.add(uid);
  }
  if (!events.length && !budgets.size && !planningUids.size) return false;

  const tx = new SqlTransaction(executor);
  const deviceOwners = new Map<string, boolean>();
  const hasDevice = async (uid: string): Promise<boolean> => {
    if (!deviceOwners.has(uid)) {
      try {
        const row = await executor.selectFrom(relationalTables.pushDevices).select('id')
          .where('uid', '=', Buffer.from(uid)).where('disabled_at', 'is', null).limit(1)
          .executeTakeFirst();
        deviceOwners.set(uid, Boolean(row));
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw error;
        deviceOwners.set(uid, false);
      }
    }
    return deviceOwners.get(uid)!;
  };
  const rows: Array<{
    ref: ReturnType<typeof documentKey>;
    data: ReturnType<typeof queuedNotificationData>;
  }> = [];
  const pending = new Set<string>();
  for (const event of events) {
    let recipients = event.userId ? [event.userId] : [];
    if (event.householdId) {
      const household = await tx.read(documentKey(queryTable('households'), event.householdId));
      recipients = (household.data?.memberIds ?? []).filter(
        (uid: string) => uid !== event.excludeUid,
      );
    }
    for (const uid of recipients) {
      if (!notificationRecipientAllowed(uid) || !(await hasDevice(uid))) continue;
      const dedupeKey = `${event.key}:${uid}`;
      const ref = documentKey(queryTable('notifications'), notificationId(dedupeKey));
      if (pending.has(ref.id)) continue;
      pending.add(ref.id);
      rows.push({
        ref,
        data: queuedNotificationData(
          {
            userId: uid,
            chatId: '',
            type: event.payload.type,
            payload: event.payload,
            dedupeKey,
            runAt: now,
          },
          now,
        ),
      });
    }
  }
  const tasks: Array<{ ref: ReturnType<typeof documentKey>; data: Record<string, unknown> }> = [];
  for (const { uid, categoryId } of budgets.values()) {
    if (!(await hasDevice(uid))) continue;
    const ref = documentKey(
      queryTable('notificationTasks'),
      notificationId(`budget_check:${uid}:${categoryId}`),
    );
    // Establish the row before locking it. Concurrent first writes cannot share a gap lock.
    await insertDocumentIfAbsent(executor, ref, {
      userId: uid, categoryId, type: 'budget_check', version: 0,
      status: 'pending', runAt: now + PUSH_BUDGET_DEBOUNCE_MS, createdAt: now,
      expiresAt: Timestamp.fromMillis(now + 90 * 86400000),
    });
    const previous = await tx.read(ref);
    const data = previous.data;
    const active = data?.status === 'processing' && Number(data.leaseUntil ?? 0) > now;
    tasks.push({
      ref,
      data: {
        userId: uid,
        categoryId,
        type: 'budget_check',
        version: Number(data?.version ?? 0) + 1,
        eventAt: now,
        updatedAt: now,
        createdAt: data?.createdAt ?? now,
        expiresAt: Timestamp.fromMillis(now + 90 * 86400000),
        ...(active
          ? { rerunAt: now + PUSH_BUDGET_DEBOUNCE_MS }
          : {
              status: 'pending',
              runAt: now + PUSH_BUDGET_DEBOUNCE_MS,
              rerunAt: null,
              leaseUntil: null,
            }),
      },
    });
  }
  for (const row of rows) await insertDocumentIfAbsent(executor, row.ref, row.data);
  for (const task of tasks) tx.save(task.ref, task.data, { merge: true });
  if (tasks.length) await tx.flush(executor);
  // Timers only wake a delivery check. The durable task is invisible until the effect commits.
  for (const task of tasks)
    afterCommit?.(() => armBudgetCheck(`${task.data.userId}:${task.data.categoryId}`, PUSH_BUDGET_DEBOUNCE_MS));
  for (const uid of planningUids) afterCommit?.(() => kickPushPlanning(uid));
  return rows.length > 0;
}
