import type { AgentDataSource } from './dataSource';
export type AgentFixture = {
  [K in keyof AgentDataSource]: Awaited<ReturnType<AgentDataSource[K]>>;
};
export function createFixtureDataSource(fixture: Partial<AgentFixture>): AgentDataSource {
  return {
    profile: async () => fixture.profile ?? null,
    transactions: async (from, to) =>
      (fixture.transactions ?? []).filter((t) => t.date >= from && t.date <= to),
    categories: async () => fixture.categories ?? [],
    subcategories: async () => fixture.subcategories ?? [],
    accounts: async () => fixture.accounts ?? [],
    budgets: async () => fixture.budgets ?? [],
    subscriptions: async () => fixture.subscriptions ?? [],
    plannedExpenses: async () => fixture.plannedExpenses ?? [],
    debts: async () => fixture.debts ?? [],
    savingsGoals: async () => fixture.savingsGoals ?? [],
  };
}
