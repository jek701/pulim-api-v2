import { getTrialBlockCode } from '../../domain/trial';
import type { UserProfile } from '../../domain/types';
import { calendarDayDifference, dateKey } from '../schedule';
import type { LifecyclePayload, NotificationState } from '../types';

export interface LifecycleCollection {
  payload: LifecyclePayload;
  stateKey: string;
  trialAvailableSent: boolean;
}

export function collectLifecycle(input: {
  uid: string;
  profile: UserProfile;
  state: NotificationState;
  now: number;
  timeZone: string;
  cardCount: number;
  trialAvailableDays: number;
  trialRepeatDays: number;
  noCardsDays: number;
}): LifecycleCollection | null {
  const { uid, profile, state, now, timeZone } = input;
  const premiumUntil = profile.subscription?.premiumUntil;
  const isTrial = profile.subscription?.isTrial === true;
  if (isTrial && typeof premiumUntil === 'number') {
    const difference = calendarDayDifference(premiumUntil, now, timeZone);
    if (difference === 1 || difference === 3) {
      const horizon = difference === 1 ? '1d' : '3d';
      const stateKey = `trial_${horizon}:${uid}:${dateKey(premiumUntil, timeZone)}`;
      if (!state.seen[stateKey]) {
        return {
          payload: { kind: difference === 1 ? 'trial_ending_1d' : 'trial_ending_3d', premiumUntil },
          stateKey,
          trialAvailableSent: false,
        };
      }
    }
  }

  if (typeof premiumUntil === 'number' && premiumUntil <= now && now - premiumUntil <= 48 * 60 * 60_000) {
    const stateKey = `premium_expired:${uid}:${dateKey(premiumUntil, timeZone)}`;
    if (!state.seen[stateKey]) {
      return { payload: { kind: 'premium_expired', premiumUntil }, stateKey, trialAvailableSent: false };
    }
  }

  const createdAt = profile.createdAt;
  const ageDays = typeof createdAt === 'number'
    ? calendarDayDifference(now, createdAt, timeZone)
    : 0;
  if (getTrialBlockCode(profile, now) === null
    && ageDays >= input.trialAvailableDays
    && state.trialAvailableSentCount < 2) {
    const repeatReady = state.trialAvailableSentCount === 0
      || (typeof state.lastTrialAvailableAt === 'number'
        && calendarDayDifference(now, state.lastTrialAvailableAt, timeZone) >= input.trialRepeatDays);
    if (repeatReady) {
      const number = state.trialAvailableSentCount + 1;
      return {
        payload: { kind: 'trial_available' },
        stateKey: `trial_available:${number}`,
        trialAvailableSent: true,
      };
    }
  }

  if (ageDays >= input.noCardsDays && ageDays <= 7 && input.cardCount === 0) {
    const stateKey = `no_cards:${uid}`;
    if (!state.seen[stateKey]) {
      return { payload: { kind: 'no_cards' }, stateKey, trialAvailableSent: false };
    }
  }
  return null;
}
