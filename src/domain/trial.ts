import type { UserProfile } from './types';

export const TRIAL_DAYS = 7;
export const TRIAL_MS = TRIAL_DAYS * 86_400_000;

export type TrialBlockCode =
  | 'PREMIUM_ALREADY_ACTIVE'
  | 'TRIAL_ALREADY_USED'
  | 'TRIAL_NOT_ELIGIBLE';

/**
 * Trial eligibility is intentionally server-owned. A user may start one trial
 * before buying Premium; an expired rollout trial or any paid history must not
 * become a second free grant.
 */
export function getTrialBlockCode(
  profile: Partial<UserProfile> | undefined,
  now = Date.now(),
): TrialBlockCode | null {
  const subscription = profile?.subscription;
  const premiumUntil = subscription?.premiumUntil;
  if (profile?.isPremium === true
    && typeof premiumUntil === 'number'
    && premiumUntil > now) {
    return 'PREMIUM_ALREADY_ACTIVE';
  }
  if (typeof subscription?.trialGrantedAt === 'number'
    || subscription?.isTrial === true
    || subscription?.source === 'trial') {
    return 'TRIAL_ALREADY_USED';
  }
  if (subscription?.source === 'atmos' || Boolean(subscription?.lastOrderId)) {
    return 'TRIAL_NOT_ELIGIBLE';
  }
  return null;
}
