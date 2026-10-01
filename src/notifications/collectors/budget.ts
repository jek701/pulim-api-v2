import type { Budget, Category, Subcategory, Transaction } from '../../domain/types';
import { calendarParts, currentMonthRange } from '../schedule';
import type { BudgetPayload, NotificationState } from '../types';

export function collectBudgetAlerts(input: {
  now: number;
  timeZone: string;
  transactions: Transaction[];
  budgets: Budget[];
  categories: Category[];
  subcategories: Subcategory[];
  state: NotificationState;
  premium: boolean;
}): Array<{ payload: BudgetPayload; stateKeys: string[]; dedupeKey: string }> {
  const parts = calendarParts(input.now, input.timeZone);
  const monthKey = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
  const { start: monthStart, end: nextMonth } = currentMonthRange(input.now, input.timeZone);
  const daysInMonth = new Date(parts.year, parts.month, 0).getDate();
  const rows = input.transactions.filter((row) => row.date >= monthStart && row.date < nextMonth);
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const subcategories = new Map(input.subcategories.map((subcategory) => [subcategory.id, subcategory]));
  const alerts: Array<{ payload: BudgetPayload; stateKeys: string[]; dedupeKey: string }> = [];
  for (const budget of input.budgets) {
    const category = categories.get(budget.categoryId);
    if (!category || budget.amount <= 0) continue;
    const categoryRows = rows.filter((row) => row.categoryId === budget.categoryId
      && row.currency === 'UZS' && row.source !== 'transfer');
    const spent = categoryRows.reduce((total, row) => total
      + (row.source === 'return' ? -row.amount : row.type === 'expense' ? row.amount : 0), 0);
    const threshold: 80 | 100 | null = spent >= budget.amount ? 100 : spent >= budget.amount * 0.8 ? 80 : null;
    if (!threshold) continue;
    const key80 = `budget80:${input.state.userId}:${budget.categoryId}:${monthKey}`;
    const key100 = `budget100:${input.state.userId}:${budget.categoryId}:${monthKey}`;
    if (threshold === 100 ? input.state.seen[key100] : input.state.seen[key80] || input.state.seen[key100]) continue;

    let topDetail: BudgetPayload['topDetail'];
    if (input.premium) {
      const details = new Map<string, number>();
      for (const row of categoryRows) {
        const amount = row.source === 'return' ? -row.amount : row.type === 'expense' ? row.amount : 0;
        if (!amount) continue;
        const label = row.subcategoryId && subcategories.get(row.subcategoryId)?.name
          || row.comment?.trim()
          || category.name;
        details.set(label, (details.get(label) ?? 0) + amount);
      }
      const first = [...details.entries()].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1])[0];
      if (first) topDetail = { label: first[0], amount: first[1] };
    }
    alerts.push({
      dedupeKey: threshold === 100 ? key100 : key80,
      stateKeys: threshold === 100 ? [key80, key100] : [key80],
      payload: {
        kind: 'budget', threshold, categoryId: budget.categoryId, categoryName: category.name,
        categoryIcon: category.icon, categoryType: category.type, spent, budget: budget.amount,
        daysLeft: Math.max(0, daysInMonth - parts.day), topDetail,
      },
    });
  }
  return alerts;
}
