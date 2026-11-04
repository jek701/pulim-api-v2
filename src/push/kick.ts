import { env } from '../config/env';
import { logger } from '../utils/logger';
let running: Promise<unknown> | undefined;
let again = false;
let stopping = false;
/** The SQL claim is shared with the worker. Coalescing only bounds work in this process. */
export function kickDelivery(): void {
  if (stopping || !env.NOTIFICATIONS_ENABLED || !env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) return;
  if (running) {
    again = true;
    return;
  }
  running = import('../notifications/delivery')
    .then(({ runDelivery }) => runDelivery())
    .catch((error) => logger.error({ err: error }, 'notify.immediate.failed'))
    .finally(() => {
      running = undefined;
      if (again) {
        again = false;
        kickDelivery();
      }
    });
}

const planning = new Map<string, { again: boolean; run?: Promise<unknown> }>();
/** Refresh new/edited reminders and timezone changes without waiting for the periodic scan. */
export function kickPushPlanning(uid: string): void {
  if (stopping || !env.NOTIFICATIONS_ENABLED || !env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) return;
  const active = planning.get(uid);
  if (active) {
    active.again = true;
    return;
  }
  const state: { again: boolean; run?: Promise<unknown> } = { again: false };
  planning.set(uid, state);
  state.run = import('./planner')
    .then(({ planPushUser }) => planPushUser(uid))
    .then(() => kickDelivery())
    .catch((error) => logger.error({ err: error, uid }, 'notify.push.replan_failed'))
    .finally(() => {
      planning.delete(uid);
      if (state.again) kickPushPlanning(uid);
    });
}

/** Stop accepting kicks and give work already using SQL/APNs a bounded drain window. */
export async function drainPushKicks(timeoutMs = 5_000): Promise<void> {
  stopping = true;
  again = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled([running, ...[...planning.values()].map(state => state.run)]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
