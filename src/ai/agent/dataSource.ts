import type {
  UserProfile,
  Transaction,
  Category,
  Subcategory,
  Card,
  Budget,
  Subscription,
  PlannedExpense,
  Debt,
  SavingsGoal,
} from '../../domain/types';
import { documentKey, filterQuery, queryTable, readDocument } from '../../db/documents';
import { dayKey, dayMs, earliestDay, validateRange } from './time';
export interface AgentDataSource {
  profile(): Promise<UserProfile | null>;
  transactions(fromMs: number, toMs: number): Promise<Transaction[]>;
  categories(): Promise<Category[]>;
  subcategories(): Promise<Subcategory[]>;
  accounts(): Promise<Card[]>;
  budgets(): Promise<Budget[]>;
  subscriptions(): Promise<Subscription[]>;
  plannedExpenses(): Promise<PlannedExpense[]>;
  debts(): Promise<Debt[]>;
  savingsGoals(): Promise<SavingsGoal[]>;
}
/** One instance per run. Cache promises too, so parallel tools share the same read. */
export function createDbDataSource(uid: string, now = Date.now()): AgentDataSource {
  const memo = new Map<string, Promise<any>>();
  const cached = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    if (!memo.has(key)) memo.set(key, read());
    return memo.get(key)!;
  };
  const owned = <T>(collection: string): Promise<T[]> =>
    cached(collection, async () => {
      const snap = await readDocument(filterQuery(queryTable(collection), 'userId', '==', uid));
      return snap.rows
        .map((doc) => ({ ...doc.data, id: doc.id }))
        .filter((row) => (row as { scope?: string }).scope !== 'household') as T[];
    });
  return {
    profile: () =>
      cached(
        'profile',
        async () =>
          ((await readDocument(documentKey(queryTable('profiles'), uid)))
            .data as UserProfile | null) ?? null,
      ),
    transactions: async (from, to) => {
      validateRange(dayKey(from), dayKey(to), now);
      // Load the widest allowed range once. Future and historical requests reuse it;
      // there is no upper-bound DB restriction, so apply the requested end in memory.
      const all = await cached<Transaction[]>('transactions', async () => {
        const snap = await readDocument(
          filterQuery(
            filterQuery(queryTable('transactions'), 'userId', '==', uid),
            'date',
            '>=',
            dayMs(earliestDay(now)),
          ),
        );
        return snap.rows.map((doc) => ({ ...doc.data, id: doc.id }) as Transaction);
      });
      return all.filter((t) => t.date >= from && t.date <= to && t.scope !== 'household');
    },
    categories: () => owned('categories'),
    subcategories: () => owned('subcategories'),
    accounts: () => owned('cards'),
    budgets: () => owned('budgets'),
    subscriptions: () => owned('subscriptions'),
    plannedExpenses: () => owned('planned_expenses'),
    debts: () => owned('debts'),
    savingsGoals: () => owned('savingsGoals'),
  };
}
