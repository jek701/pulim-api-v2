// Domain model — ported verbatim from the frontend `src/types.ts` so the API
// reads/writes the exact same Firestore document shapes.

export type Currency = 'UZS' | 'USD' | 'EUR' | 'RUB' | 'GBP' | 'CNY' | 'KZT' | 'TRY' | 'AED' | 'JPY';
export type FamilyRelation = 'spouse' | 'child' | 'parent' | 'sibling' | 'other';

export interface FamilyMember {
  id: string;
  name: string;
  birthday: string; // YYYY-MM-DD
  relation: FamilyRelation;
}

export interface SalarySource {
  id: string;
  name: string;
  day: number; // 1–31
  amount?: number;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface AiChat {
  id: string;
  userId: string;
  title: string;
  messages: AiChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface HomeWidgetSetting {
  id: 'balance' | 'askAi' | 'budget' | 'forecast' | 'exchangeRates' | 'recent';
  enabled: boolean;
}

export type PlannedExpenseVisibility = 'hidden' | '7d' | '14d' | 'this_month' | 'next_month';

export interface UserSettings {
  cardOrder?: string[];
  plannedExpenseVisibility?: PlannedExpenseVisibility;
}

export type SubscriptionTier = 'free' | 'premium';
export type AuthMethod = 'telegram' | 'email' | 'google' | 'apple' | 'phone';

export interface SubscriptionState {
  tier: SubscriptionTier;
  premiumUntil?: number;
  isTrial?: boolean;
  trialGrantedAt?: number;
  source?: 'trial' | 'atmos' | 'none';
  billingVersion?: number;
  lastOrderId?: string;
}

export interface UsageState {
  aiMessagesThisPeriod: number;
  aiPremiumMessagesThisPeriod?: number;
  periodStart: number;
}

export interface AiForecast {
  summary: string;
  predictions: string[];
  action: string;
  confidence: 'low' | 'medium' | 'high';
  generatedAt: number;
}

export interface UserProfile {
  name?: string;
  salarySources: SalarySource[];
  birthday?: string;
  familyMembers: FamilyMember[];
  financialGoals: string[];
  onboardingComplete: boolean;
  telegramChatIds?: number[];
  isTelegramUser?: boolean;
  linkedAuthMethods?: AuthMethod[];
  primaryAuthMethod?: AuthMethod | null;
  lastAuthMethod?: AuthMethod | null;
  legacyEmailLoginAllowed?: boolean;
  authMigrationCompleted?: boolean;
  telegramLinkPromptDismissed?: boolean;
  phoneNumberMasked?: string;
  authMethodsUpdatedAt?: number;
  homeWidgets?: HomeWidgetSetting[];
  language?: 'en' | 'ru' | 'uz';
  telegramQuickEntryEnabled?: boolean;
  isPremium?: boolean;
  subscription?: SubscriptionState;
  usage?: UsageState;
  updatedAt: number;
}

export type TransactionType = 'income' | 'expense';
export type CategoryType = 'income' | 'expense' | 'both';
export type DebtDirection = 'i_owe' | 'owe_me';
export type CommissionType = 'percent' | 'fixed';
export type RecurrenceType =
  | 'once' | 'daily' | 'monthly' | 'weekly' | 'weekends' | 'weekdays' | 'yearly' | 'custom';
export type CustomUnit = 'day' | 'week' | 'month' | 'year';

export type TransactionSource =
  | 'debt_payment' | 'savings' | 'transfer' | 'deposit_interest' | 'deposit_close'
  | 'deposit_replenish' | 'deposit_withdraw' | 'return' | 'subscription';

export interface PlannedExpense {
  id: string;
  userId: string;
  name: string;
  amount: number;
  currency: Currency;
  categoryId?: string;
  icon: string;
  recurrence: RecurrenceType;
  dayOfMonth?: number;
  dayOfWeek?: number[];
  date?: number;
  customInterval?: number;
  customUnit?: CustomUnit;
  endDate?: number;
  kind?: 'income' | 'expense';
  createdAt: number;
}

export type BillingCycle = 'weekly' | 'monthly' | 'yearly';

export interface Subscription {
  id: string;
  name: string;
  icon: string;
  amount: number;
  currency: Currency;
  cycle: BillingCycle;
  nextBillingDate: number;
  categoryId?: string;
  note?: string;
  isActive: boolean;
  userId: string;
  createdAt: number;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  type: CategoryType;
  userId: string;
  createdAt: number;
}

export interface Subcategory {
  id: string;
  name: string;
  categoryId: string;
  userId: string;
  createdAt: number;
}

export interface Transaction {
  id: string;
  amount: number;
  currency: Currency;
  type: TransactionType;
  categoryId: string;
  subcategoryId?: string;
  cardId?: string;
  comment?: string;
  source?: TransactionSource;
  origin?: 'telegram';
  sourceLabel?: string;
  toCardId?: string;
  toAmount?: number;
  toCurrency?: Currency;
  linkedTransactionId?: string;
  returnedAmount?: number;
  baseAmount?: number;
  fxRate?: number;
  fxRateSource?: 'NBU' | 'manual';
  date: number;
  userId: string;
  createdAt: number;
}

export type CardType = 'credit' | 'debit' | 'cash';
export type CapitalizationType = 'monthly' | 'quarterly' | 'at_end' | 'custom';

export interface DepositTranche {
  amount: number; // positive = top-up, negative = withdrawal
  date: number;
}

export interface Card {
  id: string;
  cardType: CardType;
  name: string;
  bank: string;
  currency: Currency;
  balance: number;
  includeInTotalBalance?: boolean;
  limit?: number;
  dueDay?: number;
  userId: string;
  createdAt: number;
}

export interface Budget {
  id: string; // `${userId}_${categoryId}`
  categoryId: string; // '__income__' for salary target
  amount: number;
  currency: Currency;
  userId: string;
  updatedAt: number;
}

export interface SavingsGoal {
  id: string;
  name: string;
  icon: string;
  targetAmount: number;
  savedAmount: number;
  currency: Currency;
  deadline: number;
  userId: string;
  createdAt: number;
}

export interface Commission {
  type: CommissionType;
  value: number;
}

export interface Debt {
  id: string;
  direction: DebtDirection;
  person: string;
  amount: number;
  paidAmount: number;
  currency: Currency;
  commission?: Commission;
  dueDate?: number;
  comment?: string;
  isPaid: boolean;
  userId: string;
  createdAt: number;
}

export interface Deposit {
  id: string;
  userId: string;
  bank: string;
  amount: number;
  currency: Currency;
  interestRate: number;
  startDate: number;
  endDate: number;
  capitalization: CapitalizationType;
  customCapitalizationDays?: number;
  showInterest: boolean;
  interestToAccountId?: string;
  interestPaidOut: number;
  lastInterestPaidAt?: number;
  isReplenishable: boolean;
  tranches?: DepositTranche[];
  isClosed: boolean;
  closedAt?: number;
  createdAt: number;
}

export const CURRENCIES: Currency[] = [
  'UZS', 'USD', 'EUR', 'RUB', 'GBP', 'CNY', 'KZT', 'TRY', 'AED', 'JPY',
];
