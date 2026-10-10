import { z } from 'zod';
import { CURRENCIES } from './types';

// --- Primitives ---
export const currencySchema = z.enum(CURRENCIES as [string, ...string[]]);
const positive = z.number().finite();
const dayOfMonth = z.number().int().min(1).max(31);

// --- Auth ---
export const telegramAuthSchema = z.object({
  telegramInitData: z.string().min(1),
  chatId: z.union([z.string(), z.number()]).transform(String),
  language: z.enum(['uz', 'ru', 'en']).optional(),
  firebaseIdToken: z.string().min(1).optional(),
});
export type TelegramAuthBody = z.infer<typeof telegramAuthSchema>;

/** Phone sign-in over the Eskiz SMS gateway. */
const phoneNumberSchema = z.string().min(9).max(20);
const phonePurposeSchema = z.enum(['signin', 'link']).default('signin');

export const phoneSendCodeSchema = z.object({
  phone: phoneNumberSchema,
  purpose: phonePurposeSchema,
  language: z.enum(['uz', 'ru', 'en']).optional(),
  firebaseIdToken: z.string().min(1).optional(),
});
export type PhoneSendCodeBody = z.infer<typeof phoneSendCodeSchema>;

export const phoneVerifyCodeSchema = z.object({
  phone: phoneNumberSchema,
  code: z.string().regex(/^\d{6}$/, 'The code is 6 digits.'),
  purpose: phonePurposeSchema,
  firebaseIdToken: z.string().min(1).optional(),
});
export type PhoneVerifyCodeBody = z.infer<typeof phoneVerifyCodeSchema>;

// --- Profile ---
const salarySourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  day: dayOfMonth,
  amount: z.number().optional(),
});

const familyMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  birthday: z.string(),
  relation: z.enum(['spouse', 'child', 'parent', 'sibling', 'other']),
});

const homeWidgetSchema = z.object({
  id: z.enum(['balance', 'askAi', 'budget', 'forecast', 'exchangeRates', 'recent']),
  enabled: z.boolean(),
});

// Only user-editable fields. isPremium / subscription / usage / auth metadata are
// intentionally absent so a client can never grant itself Premium.
export const profilePatchSchema = z
  .object({
    name: z.string().optional(),
    birthday: z.string().optional(),
    salarySources: z.array(salarySourceSchema).optional(),
    familyMembers: z.array(familyMemberSchema).optional(),
    financialGoals: z.array(z.string()).optional(),
    onboardingComplete: z.boolean().optional(),
    homeWidgets: z.array(homeWidgetSchema).optional(),
    telegramLinkPromptDismissed: z.boolean().optional(),
    language: z.enum(['en', 'ru', 'uz']).optional(),
    telegramQuickEntryEnabled: z.boolean().optional(),
    notificationsPromptDismissed: z.boolean().optional(),
  })
  .strip();

export const notificationSettingsPatchSchema = z.object({ enabled: z.boolean() }).strip();

export const homeWidgetsSchema = z.object({ homeWidgets: z.array(homeWidgetSchema) });

// --- Settings ---
export const settingsPatchSchema = z
  .object({
    cardOrder: z.array(z.string()).optional(),
    plannedExpenseVisibility: z.enum(['hidden', '7d', '14d', 'this_month', 'next_month']).optional(),
  })
  .strip();

// --- Categories ---
export const categoryCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string(),
  color: z.string(),
  type: z.enum(['income', 'expense', 'both']),
});

export const subcategoryCreateSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().min(1),
});

// --- Cards ---
export const cardCreateSchema = z.object({
  cardType: z.enum(['credit', 'debit', 'cash']),
  name: z.string().min(1),
  bank: z.string(),
  currency: currencySchema,
  balance: positive,
  includeInTotalBalance: z.boolean().optional(),
  limit: positive.optional(),
  dueDay: dayOfMonth.optional(),
  /** Palette key for the card's gradient in the UI (e.g. 'violet'); unset = auto by bank. */
  color: z.string().regex(/^[a-z]{2,16}$/).optional(),
});
export const cardUpdateSchema = cardCreateSchema.partial();

// --- Household budget ---
export const householdCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  currency: currencySchema.default('UZS'),
});

export const householdUpdateSchema = householdCreateSchema.pick({ name: true }).partial();

export const householdCardAccessSchema = z.object({
  enabled: z.boolean(),
  showBalance: z.boolean().default(false),
});

// --- Budgets ---
export const budgetSetSchema = z.object({
  amount: positive,
  currency: currencySchema,
});

// --- Savings goals ---
const colorKey = z.string().regex(/^[a-z]{2,16}$/);

export const savingsGoalCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string(),
  targetAmount: positive,
  currency: currencySchema,
  deadline: z.number(),
  /** Palette key for the goal's gradient in the UI; unset = auto by name. */
  color: colorKey.optional(),
});
/** savedAmount and currency are deliberately absent: they only move via contributions. */
export const savingsGoalUpdateSchema = savingsGoalCreateSchema
  .pick({ name: true, icon: true, deadline: true, color: true })
  .extend({ targetAmount: z.number().finite().positive() })
  .partial();

// --- Subscriptions ---
export const subscriptionCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string(),
  amount: positive,
  currency: currencySchema,
  cycle: z.enum(['weekly', 'monthly', 'yearly']),
  nextBillingDate: z.number(),
  categoryId: z.string().optional(),
  note: z.string().optional(),
  isActive: z.boolean().default(true),
});
export const subscriptionUpdateSchema = subscriptionCreateSchema.partial();

// --- Planned expenses ---
export const plannedExpenseCreateSchema = z.object({
  name: z.string().min(1),
  amount: positive,
  currency: currencySchema,
  categoryId: z.string().optional(),
  icon: z.string(),
  recurrence: z.enum(['once', 'daily', 'monthly', 'weekly', 'weekends', 'weekdays', 'yearly', 'custom']),
  dayOfMonth: dayOfMonth.optional(),
  dayOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  date: z.number().optional(),
  customInterval: z.number().int().positive().optional(),
  customUnit: z.enum(['day', 'week', 'month', 'year']).optional(),
  endDate: z.number().optional(),
  kind: z.enum(['income', 'expense']).optional(),
});
export const plannedExpenseUpdateSchema = plannedExpenseCreateSchema.partial();

// --- Transactions (atomic) ---
export const transactionCreateSchema = z.object({
  amount: positive,
  currency: currencySchema,
  type: z.enum(['income', 'expense']),
  categoryId: z.string().min(1),
  subcategoryId: z.string().optional(),
  cardId: z.string().optional(),
  comment: z.string().optional(),
  baseAmount: z.number().optional(),
  fxRate: z.number().optional(),
  fxRateSource: z.enum(['NBU', 'manual']).optional(),
  date: z.number(),
});
export const transactionUpdateSchema = transactionCreateSchema.partial();

export const transferSchema = z.object({
  fromCardId: z.string().min(1),
  toCardId: z.string().min(1),
  amount: positive,
  toAmount: positive.optional(),
  // Optional FX snapshot (computed client-side from public NBU rates).
  baseAmount: z.number().optional(),
  fxRate: z.number().optional(),
  fxRateSource: z.enum(['NBU', 'manual']).optional(),
});

/** Full editable shape for an existing transfer. Financial fields are required so
 * the service can rebuild both legs from one authoritative payload. */
export const transferUpdateSchema = transferSchema.extend({
  date: z.number(),
  comment: z.string().trim().max(500).optional(),
});

export const returnSchema = z.object({
  returnAmount: positive,
  accountId: z.string().optional(),
  date: z.number().optional(),
  /** Free-text note, e.g. who refunded the money. */
  comment: z.string().trim().max(500).optional(),
});

export const returnUpdateSchema = returnSchema.extend({
  date: z.number(),
});

export const refillSchema = z.object({
  creditCardId: z.string().min(1),
  sourceCardId: z.string().min(1),
  amount: positive,
});

// --- Debts (atomic) ---
const commissionSchema = z.object({ type: z.enum(['percent', 'fixed']), value: z.number() });
export const debtCreateSchema = z.object({
  direction: z.enum(['i_owe', 'owe_me']),
  person: z.string().min(1),
  amount: positive,
  currency: currencySchema,
  commission: commissionSchema.optional(),
  dueDate: z.number().optional(),
  comment: z.string().optional(),
  accountId: z.string().optional(),
});
export const debtUpdateSchema = z
  .object({
    isPaid: z.boolean().optional(),
    person: z.string().optional(),
    comment: z.string().optional(),
    /** null removes the due date. */
    dueDate: z.number().nullable().optional(),
  })
  .strip();
export const payDebtSchema = z.object({ amount: positive, accountId: z.string().optional() });

// --- Deposits (atomic) ---
export const depositCreateSchema = z.object({
  bank: z.string().min(1),
  amount: positive,
  currency: currencySchema,
  interestRate: z.number(),
  startDate: z.number(),
  endDate: z.number(),
  capitalization: z.enum(['monthly', 'quarterly', 'at_end', 'custom']),
  customCapitalizationDays: z.number().int().positive().optional(),
  showInterest: z.boolean(),
  interestToAccountId: z.string().optional(),
  isReplenishable: z.boolean(),
});
export const depositCloseSchema = z.object({ accountId: z.string().min(1) });
export const depositAccountAmountSchema = z.object({ accountId: z.string().min(1), amount: positive });

// --- Subscription pay / savings contribute ---
export const accountOnlySchema = z.object({ accountId: z.string().optional() });
export const contributeSchema = z.object({ amount: positive, accountId: z.string().optional() });

// --- AI ---
const aiLanguageSchema = z.enum(['en', 'ru', 'uz']).default('en');
export const forecastSchema = z.object({ language: aiLanguageSchema.optional() }).strict();
export const chatSchema = z.object({
  chatId: z.string().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(4000),
  language: aiLanguageSchema.optional(),
}).strict();
export const renameChatSchema = z.object({ title: z.string().trim().min(1).max(80) }).strict();
export const aiFeedbackSchema = z.object({
  chatId: z.string().min(1).max(128),
  messageIndex: z.number().int().nonnegative(),
  rating: z.enum(['up', 'down']),
}).strict();

// --- Path params ---
export const idParamSchema = z.object({ id: z.string().min(1) });
