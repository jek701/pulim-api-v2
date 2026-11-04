import type { DocumentData, DocumentKey } from '../db/documents';
import type { PushPayload } from './types';

export interface WriteChange {
  key: DocumentKey;
  before?: DocumentData;
  after: DocumentData;
}
export interface PushEvent {
  userId?: string;
  householdId?: string;
  excludeUid?: string;
  key: string;
  payload: PushPayload;
}

/** Derive events from committed document transitions, including bot and household writes. */
export function immediateEvents(change: WriteChange, now: number): PushEvent[] {
  const { key, before, after } = change;
  const event = (
    type: PushPayload['type'],
    group: PushPayload['group'],
    link: string,
    values: PushPayload['values'],
    dedupe: string,
  ): PushEvent => ({
    userId: after.userId,
    key: dedupe,
    payload: { kind: 'push', type, group, link, entityId: key.id, values, eventAt: now },
  });
  if (
    key.table === 'savingsGoals' &&
    Number(after.targetAmount) > 0 &&
    Number(after.savedAmount) >= Number(after.targetAmount) &&
    Number(before?.savedAmount ?? 0) < Number(after.targetAmount)
  ) {
    const result = event(
      'goal_reached',
      'money',
      `/goals/${encodeURIComponent(key.id)}`,
      { name: after.name, amount: after.savedAmount, currency: after.currency },
      `goal_reached:${key.id}`,
    );
    if (after.householdId) {
      delete result.userId;
      result.householdId = after.householdId;
    }
    return [result];
  }
  if (key.table === 'households' && before) {
    const previous: string[] = before.memberIds ?? [];
    const joined = ((after.memberIds as string[]) ?? []).filter((uid) => !previous.includes(uid));
    return joined.flatMap((uid) =>
      previous.map((recipient) => {
        const result = event(
          'family_joined',
          'family',
          '/family',
          {
            name:
              ((after.members as Array<{ userId: string; name: string }>) ?? []).find(
                (m) => m.userId === uid,
              )?.name ?? '',
          },
          `family_joined:${key.id}:${uid}:${recipient}`,
        );
        result.userId = recipient;
        return result;
      }),
    );
  }
  if (
    key.table === 'transactions' &&
    !before &&
    after.scope === 'household' &&
    after.type === 'expense' &&
    !after.source
  ) {
    const result = event(
      'family_expense',
      'familyExpenses',
      '/family',
      {
        name: after.createdByName ?? '',
        amount: after.amount,
        currency: after.currency,
        category: after.categoryName ?? '',
      },
      `family_expense:${key.id}`,
    );
    delete result.userId;
    result.householdId = after.householdId;
    result.excludeUid = after.createdBy;
    return [result];
  }
  if (
    key.table === 'profiles' &&
    after.isPremium === true &&
    !after.subscription?.isTrial &&
    Number(after.subscription?.premiumUntil) > now &&
    ['atmos', 'apple'].includes(after.subscription?.source) &&
    (before?.subscription?.premiumUntil !== after.subscription?.premiumUntil ||
      before?.subscription?.lastOrderId !== after.subscription?.lastOrderId)
  ) {
    const result = event(
      'premium_activated',
      'premium',
      '/premium',
      { date: after.subscription.premiumUntil },
      `premium_activated:${key.id}:${after.subscription.lastOrderId ?? after.subscription.premiumUntil}`,
    );
    result.userId = key.id;
    return [result];
  }
  return [];
}
