import { describe, expect, it } from 'vitest';
import { collectLifecycle } from '../../src/notifications/collectors/lifecycle';
import { emptyNotificationState } from '../../src/notifications/state.repository';
import type { UserProfile } from '../../src/domain/types';

const now = Date.parse('2026-09-02T05:00:00Z');
const profile = (patch: Partial<UserProfile> = {}) => ({
  salarySources: [], familyMembers: [], financialGoals: [], onboardingComplete: false,
  createdAt: now - 4 * 86_400_000, updatedAt: now, ...patch,
}) as UserProfile;
const common = {
  uid: 'u', state: emptyNotificationState('u'), now, timeZone: 'Asia/Tashkent', cardCount: 1,
  trialAvailableDays: 3, trialRepeatDays: 21, noCardsDays: 2,
};

describe('lifecycle collector', () => {
  it('prioritizes a trial ending tomorrow', () => {
    const result = collectLifecycle({ ...common, profile: profile({
      isPremium: true,
      subscription: { tier: 'premium', isTrial: true, premiumUntil: now + 86_400_000, source: 'trial' },
    }) });
    expect(result?.payload.kind).toBe('trial_ending_1d');
  });

  it('offers a trial at most twice and respects the repeat delay', () => {
    expect(collectLifecycle({ ...common, profile: profile() })?.payload.kind).toBe('trial_available');
    expect(collectLifecycle({ ...common, profile: profile(), state: {
      ...emptyNotificationState('u'), trialAvailableSentCount: 2,
    } })).toBeNull();
  });

  it('only checks no-cards in the 2-7 day window', () => {
    const ineligible = profile({ subscription: { tier: 'free', source: 'atmos' }, createdAt: now - 8 * 86_400_000 });
    expect(collectLifecycle({ ...common, profile: ineligible, cardCount: 0 })).toBeNull();
  });
});
