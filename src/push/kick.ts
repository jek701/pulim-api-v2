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
