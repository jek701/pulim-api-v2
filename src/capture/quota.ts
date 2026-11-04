import { getIsPremium } from '../services/entitlement.service';
import { getCaptureUsage, reserveCaptureUsage, refundCaptureUsage, takeCaptureRefund } from './repository';
import { captureMonth, dateInTimezone } from './time';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export const CAPTURE_FREE_LIMIT = 5;
export const CAPTURE_PREMIUM_LIMIT = 300;
/** Refunds for user-caused empty results (silence, not a receipt) per user per Tashkent day. */
export const CAPTURE_DAILY_REFUND_CAP = 5;

export async function captureQuota(uid: string, now = new Date()) {
  const { month, resetsAt } = captureMonth(now);
  const premium = await getIsPremium(uid);
  return { used: await getCaptureUsage(uid, month), limit: premium ? CAPTURE_PREMIUM_LIMIT : CAPTURE_FREE_LIMIT, resetsAt, premium };
}

export interface QuotaControl {
  /** The call produced nothing worth a recognition (e.g. silence): give the reservation back, within the daily cap. */
  release(): void;
}

/** Errors the user caused rather than the provider: refunded only within the daily cap. */
const USER_CAUSED = new Set(['not_a_receipt']);

/**
 * Reserve atomically before an expensive request. Provider failures and a client that disconnected
 * before the response could be written always refund. Empty results the user caused (nothing
 * recognised, not a receipt) refund up to CAPTURE_DAILY_REFUND_CAP a day, then the call counts.
 */
export async function withCaptureQuota<T>(uid: string, count: boolean,
  work: (control: QuotaControl) => Promise<T>, options: { signal?: AbortSignal } = {}) {
  const now = new Date();
  const { month } = captureMonth(now);
  const day = dateInTimezone(now, 'Asia/Tashkent').slice(0, 10);
  const before = await captureQuota(uid, now);
  if (count && !await reserveCaptureUsage(uid, month, before.limit)) {
    throw new AppError(402, 'capture_quota_exceeded', undefined, { quota: await captureQuota(uid, now) });
  }
  const refund = async () => {
    try { await refundCaptureUsage(uid, month); }
    catch { logger.warn('capture.quota_refund_failed'); }
  };
  /** True when the slot was given back. */
  const refundUserCaused = async (): Promise<boolean> => {
    try {
      if (!await takeCaptureRefund(uid, day, CAPTURE_DAILY_REFUND_CAP)) return false;
    } catch { logger.warn('capture.quota_refund_failed'); return false; }
    await refund();
    return true;
  };
  let released = false;
  let result: T;
  try { result = await work({ release: () => { released = true; } }); }
  catch (error) {
    if (count) {
      if (error instanceof AppError && USER_CAUSED.has(error.code)) await refundUserCaused();
      else await refund();
    }
    throw error;
  }
  let charged = count;
  if (count && options.signal?.aborted) {
    // The user never received the answer.
    await refund();
    charged = false;
  } else if (count && released) {
    charged = !await refundUserCaused();
  }
  return { ...result, quota: { ...before, used: charged ? before.used + 1 : before.used } };
}
