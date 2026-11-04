export const PUSH_TYPES = [
  'budget_80', 'budget_100', 'subscription_due', 'debt_3d', 'debt_due', 'debt_overdue',
  'credit_card_due', 'deposit_ending', 'deposit_interest', 'goal_reached', 'goal_deadline',
  'family_expense', 'family_joined', 'premium_activated', 'trial_ending', 'premium_expired',
  'apple_billing_failed', 'evening_log', 'weekly_summary', 'monthly_summary', 'broadcast',
] as const;

export type PushType = typeof PUSH_TYPES[number];
export type PushGroup = 'money' | 'family' | 'familyExpenses' | 'premium' | 'habit';

export interface PushPayload {
  kind: 'push';
  type: PushType;
  group: PushGroup;
  entityId?: string;
  link: string;
  /** Amounts and dates are formatted in the recipient's language before enqueueing. */
  values: Record<string, string | number>;
  eventAt: number;
}

export interface ApnsPayload {
  aps: {
    alert: { title: string; body: string };
    sound: 'default';
    'thread-id': PushGroup;
    category?: 'SUBSCRIPTION_DUE' | 'DEBT_DUE' | 'EVENING_LOG';
    'interruption-level': 'active' | 'time-sensitive';
  };
  type: PushType;
  link: string;
  entityId?: string;
  notificationId: string;
}

export interface ScheduledPushCandidate extends Omit<PushPayload, 'kind'> {
  runAt: number;
  dedupeKey: string;
}
