import { env } from '../config/env';
import { logger } from '../utils/logger';
let running: Promise<unknown> | undefined;
let again = false;
/** The SQL claim is shared with the worker. Coalescing only bounds work in this process. */
export function kickDelivery(): void {
  if (!env.NOTIFICATIONS_ENABLED || !env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) return;
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

const planning = new Map<string, { again: boolean }>();
/** Refresh new/edited reminders and timezone changes without waiting for the periodic scan. */
export function kickPushPlanning(uid: string): void {
  if (!env.NOTIFICATIONS_ENABLED || !env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) return;
  const active = planning.get(uid);
  if (active) {
    active.again = true;
    return;
  }
  const state = { again: false };
  planning.set(uid, state);
  void import('./planner')
    .then(({ planPushUser }) => planPushUser(uid))
    .then(() => kickDelivery())
    .catch((error) => logger.error({ err: error, uid }, 'notify.push.replan_failed'))
    .finally(() => {
      planning.delete(uid);
      if (state.again) kickPushPlanning(uid);
    });
}
