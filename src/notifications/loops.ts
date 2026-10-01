import { env } from '../config/env';
import { logger } from '../utils/logger';
import { runDelivery } from './delivery';
import { runPlanner } from './planner';

export interface NotificationLoops {
  stop: () => Promise<void>;
}

export function startNotificationLoops(options: { unref: boolean }): NotificationLoops {
  let stopping = false;
  let plannerRun: Promise<unknown> | undefined;
  let deliveryRun: Promise<unknown> | undefined;

  const planner = () => {
    if (stopping || plannerRun) return;
    plannerRun = runPlanner()
      .catch((error) => logger.error({ err: error }, 'notify.planner.failed'))
      .finally(() => { plannerRun = undefined; });
  };
  const delivery = () => {
    if (stopping || deliveryRun) return;
    deliveryRun = runDelivery()
      .catch((error) => logger.error({ err: error }, 'notify.delivery.failed'))
      .finally(() => { deliveryRun = undefined; });
  };

  const plannerTimer = setInterval(planner, env.NOTIFY_PLANNER_INTERVAL_MS);
  const deliveryTimer = setInterval(delivery, env.NOTIFY_DELIVERY_INTERVAL_MS);
  if (options.unref) {
    plannerTimer.unref();
    deliveryTimer.unref();
  }
  planner();
  delivery();
  logger.info({ embedded: options.unref }, 'notify.loops.started');

  return {
    stop: async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(plannerTimer);
      clearInterval(deliveryTimer);
      await Promise.allSettled([plannerRun, deliveryRun].filter((run): run is Promise<unknown> => Boolean(run)));
    },
  };
}
