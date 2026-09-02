import { describe, expect, it } from 'vitest';
import { getTrialBlockCode, TRIAL_DAYS, TRIAL_MS } from '../../src/domain/trial';

const NOW = 1_800_000_000_000;

describe('Premium trial eligibility', () => {
  it('uses a seven-day duration for new grants', () => {
    expect(TRIAL_DAYS).toBe(7);
    expect(TRIAL_MS).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('allows a profile with no subscription history', () => {
    expect(getTrialBlockCode({ isPremium: false }, NOW)).toBeNull();
  });

  it('does not shorten or replace an active rollout trial', () => {
    expect(getTrialBlockCode({
      isPremium: true,
      subscription: {
        tier: 'premium',
        isTrial: true,
        trialGrantedAt: NOW - 10_000,
        premiumUntil: NOW + 23 * 86_400_000,
        source: 'trial',
      },
    }, NOW)).toBe('PREMIUM_ALREADY_ACTIVE');
  });

  it('does not re-grant an expired trial', () => {
    expect(getTrialBlockCode({
      isPremium: true,
      subscription: {
        tier: 'premium',
        isTrial: true,
        trialGrantedAt: NOW - 30 * 86_400_000,
        premiumUntil: NOW - 23 * 86_400_000,
        source: 'trial',
      },
    }, NOW)).toBe('TRIAL_ALREADY_USED');
  });

  it('does not grant a trial after paid Premium', () => {
    expect(getTrialBlockCode({
      isPremium: false,
      subscription: {
        tier: 'free',
        isTrial: false,
        source: 'atmos',
        lastOrderId: 'paid-order',
      },
    }, NOW)).toBe('TRIAL_NOT_ELIGIBLE');
  });
});
