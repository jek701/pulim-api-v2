import type { SupportedLanguage } from '../telegram/types';

export type NotificationType = 'daily' | 'budget_80' | 'budget_100' | 'trial_started';
export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'cancelled';

export interface SubscriptionEvent {
  kind: 'subscription';
  id: string;
  name: string;
  icon: string;
  amount: number;
  currency: string;
  nextBillingDate: number;
  due: 'today' | 'tomorrow';
}

export interface DebtEvent {
  kind: 'debt';
  id: string;
  person: string;
  direction: 'i_owe' | 'owe_me';
  remaining: number;
  currency: string;
  due: 'in_3_days' | 'today' | 'overdue';
}

export interface CreditCardEvent {
  kind: 'credit_card';
  id: string;
  name: string;
  balance: number;
  currency: string;
  due: 'today' | 'in_2_days';
}

export interface DepositEvent {
  kind: 'deposit';
  id: string;
  bank: string;
  amount: number;
  currency: string;
  event: 'ends_7d' | 'ends_1d' | 'interest';
}

export interface GoalEvent {
  kind: 'goal';
  id: string;
  name: string;
  remaining: number;
  currency: string;
}

export type DailyEvent = SubscriptionEvent | DebtEvent | CreditCardEvent | DepositEvent | GoalEvent;

export interface LifecyclePayload {
  kind: 'trial_ending_1d' | 'trial_ending_3d' | 'premium_expired' | 'trial_available' | 'no_cards';
  premiumUntil?: number;
}

export interface CategoryTotal {
  categoryId: string;
  name: string;
  icon: string;
  categoryType: 'income' | 'expense' | 'both';
  amount: number;
  percent?: number;
}

export interface WeeklyPayload {
  kind: 'weekly';
  from: number;
  to: number;
  income: number;
  expense: number;
  operationCount: number;
  unconvertedCount: number;
  expenseChangePercent: number | null;
  topCategories: CategoryTotal[];
  empty: boolean;
  aiInsight?: string;
}

export interface MonthlyPayload {
  kind: 'monthly';
  monthStart: number;
  income: number;
  expense: number;
  unconvertedCount: number;
  topCategories: CategoryTotal[];
  budgetsOk: number;
  budgetsTotal: number;
  exceededBudgets: Array<CategoryTotal & { overBy: number }>;
  subscriptionsTotal: number;
  aiInsight?: { insight: string; tip: string };
  premiumUpsell: boolean;
}

export interface DailyPayload {
  kind: 'daily';
  date: number;
  lifecycle?: LifecyclePayload;
  events: DailyEvent[];
  report?: WeeklyPayload | MonthlyPayload;
  premiumDataUpsell: boolean;
}

export interface BudgetPayload {
  kind: 'budget';
  threshold: 80 | 100;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  categoryType: 'income' | 'expense' | 'both';
  spent: number;
  budget: number;
  daysLeft: number;
  topDetail?: { label: string; amount: number };
}

export interface TrialStartedPayload {
  kind: 'trial_started';
  premiumUntil: number;
}

export type NotificationPayload = DailyPayload | BudgetPayload | TrialStartedPayload;

export interface NotificationStateEffects {
  trialAvailableSent?: boolean;
  weeklyEmpty?: boolean;
  weeklyActive?: boolean;
}

export interface QueuedNotification {
  id: string;
  userId: string;
  chatId: string;
  type: NotificationType;
  dedupeKey: string;
  status: NotificationStatus;
  runAt: number;
  staleAt: number;
  deferredUntil: number | null;
  nextAttemptAt: number;
  leaseUntil: number | null;
  attempts: number;
  lastError: string | null;
  skipReason: string | null;
  payload: NotificationPayload;
  stateKeys: string[];
  stateEffects: NotificationStateEffects;
  messageId: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface NotificationState {
  userId: string;
  seen: Record<string, number>;
  trialAvailableSentCount: number;
  lastTrialAvailableAt: number | null;
  weeklyEmptyStreak: number;
  updatedAt: number;
}

export interface RenderedNotification {
  text: string;
  keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>> };
  items: Array<{
    draftId: null;
    transactionId: null;
    subscriptionId?: string;
    debtId?: string;
    expectedNextBillingDate?: number;
  }>;
  language: SupportedLanguage;
}
