// Ported from the frontend `src/hooks/useEntitlements.ts`. `isPremium` on the
// profile is the single source of truth; the API enforces these server-side.

export const FREE_LIMITS = {
  cards: 1,
  allowedCardTypes: ['debit'] as const,
  aiMessagesPerMonth: 10,
  aiChats: 1,
  subscriptions: 2,
  aiModel: 'claude-haiku-4-5-20251001',
} as const;

export const PREMIUM_LIMITS = {
  aiModel: 'claude-sonnet-4-6',
} as const;

export const MONTH_MS = 30 * 86_400_000;

export type FeatureKey =
  | 'extra_cards'
  | 'credit_cash_cards'
  | 'custom_categories'
  | 'budgets'
  | 'debts_create'
  | 'deposits_create'
  | 'savings_create'
  | 'planned_expenses'
  | 'advanced_charts'
  | 'advanced_filters'
  | 'ai_chat'
  | 'ai_extra_chats'
  | 'extra_subscriptions';

/** Count-limited resources whose free cap depends on the current document count. */
export type CountLimitedFeature = 'extra_cards' | 'extra_subscriptions';

/**
 * Mirrors `canUse` from the frontend. For count-limited features pass the current
 * count; `aiRemaining` is only relevant to `ai_chat`.
 */
export function canUse(
  feature: FeatureKey,
  opts: { isPremium: boolean; count?: number; aiRemaining?: number },
): boolean {
  if (opts.isPremium) return true;
  switch (feature) {
    case 'extra_cards':
      return (opts.count ?? 0) < FREE_LIMITS.cards;
    case 'extra_subscriptions':
      return (opts.count ?? 0) < FREE_LIMITS.subscriptions;
    case 'credit_cash_cards':
    case 'custom_categories':
    case 'budgets':
    case 'debts_create':
    case 'deposits_create':
    case 'savings_create':
    case 'planned_expenses':
    case 'advanced_charts':
    case 'advanced_filters':
    case 'ai_extra_chats':
      return false;
    case 'ai_chat':
      return (opts.aiRemaining ?? 0) > 0;
  }
}

export function selectModel(isPremium: boolean): string {
  return isPremium ? PREMIUM_LIMITS.aiModel : FREE_LIMITS.aiModel;
}
