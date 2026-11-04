import { getIsPremium } from '../services/entitlement.service';
import { getCaptureUsage, reserveCaptureUsage, refundCaptureUsage } from './repository';
import { captureMonth } from './time';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export const CAPTURE_FREE_LIMIT = 5;
export const CAPTURE_PREMIUM_LIMIT = 300;

export async function captureQuota(uid: string, now = new Date()) {
  const { month, resetsAt } = captureMonth(now);
  const premium = await getIsPremium(uid);
  return { used: await getCaptureUsage(uid, month), limit: premium ? CAPTURE_PREMIUM_LIMIT : CAPTURE_FREE_LIMIT, resetsAt, premium };
}

export interface QuotaControl {
  /** The call produced nothing worth a recognition (e.g. silence): give the reservation back. */
  release(): void;
}

/** Reserve atomically before an expensive request; refund only this reservation on failure. */
export async function withCaptureQuota<T>(uid: string, count: boolean,
  work: (control: QuotaControl) => Promise<T>) {
  const now = new Date();
  const { month } = captureMonth(now);
  const before = await captureQuota(uid, now);
  if (count && !await reserveCaptureUsage(uid, month, before.limit)) {
    throw new AppError(402, 'capture_quota_exceeded', undefined, { quota: await captureQuota(uid, now) });
  }
  const refund = async () => {
    try { await refundCaptureUsage(uid, month); }
    catch { logger.warn('capture.quota_refund_failed'); }
  };
  let released = false;
  let result: T;
  try { result = await work({ release: () => { released = true; } }); }
  catch (error) {
    if (count) await refund();
    throw error;
  }
  if (count && released) await refund();
  const charged = count && !released;
  return { ...result, quota: { ...before, used: charged ? before.used + 1 : before.used } };
}
