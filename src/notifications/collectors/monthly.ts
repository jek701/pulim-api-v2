import type { Budget, Category, Transaction } from '../../domain/types';
import { dateKey, previousMonthRange } from '../schedule';
import type { MonthlyPayload } from '../types';

function baseValue(transaction: Transaction): number | null {
  if (transaction.currency === 'UZS') return transaction.amount;
  return typeof transaction.baseAmount === 'number' ? transaction.baseAmount : null;
}

export function collectMonthly(input: {
  now: number;
  timeZone: string;
  transactions: Transaction[];
  categories: Category[];
  budgets: Budget[];
  premium: boolean;
  seen: Record<string, number>;
}): { payload: MonthlyPayload; stateKey: string } | null {
  const range = previousMonthRange(input.now, input.timeZone);
  const stateKey = `monthly:${dateKey(range.start, input.timeZone).slice(0, 7)}`;
  if (input.seen[stateKey]) return null;
  const rows = input.transactions.filter((row) => row.date >= range.start && row.date < range.end && row.source !== 'transfer');
  let income = 0;
  let expense = 0;
  let unconvertedCount = 0;
  let subscriptionsTotal = 0;
  const categoryTotals = new Map<string, number>();
  for (const row of rows) {
    const value = baseValue(row);
    if (value === null) {
      unconvertedCount += 1;
      continue;
    }
    if (row.source === 'return') {
      expense -= value;
      categoryTotals.set(row.categoryId, (categoryTotals.get(row.categoryId) ?? 0) - value);
    } else if (row.type === 'income') income += value;
    else {
      expense += value;
      categoryTotals.set(row.categoryId, (categoryTotals.get(row.categoryId) ?? 0) + value);
      if (row.source === 'subscription') subscriptionsTotal += value;
    }
  }
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const expenseCategories = [...categoryTotals.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => right[1] - left[1])
    .flatMap(([categoryId, amount]) => {
      const category = categories.get(categoryId);
      return category ? [{
        categoryId,
        name: category.name,
        icon: category.icon,
        categoryType: category.type,
        amount,
        percent: expense > 0 ? Math.round((amount / expense) * 100) : 0,
      }] : [];
    });
  const normalBudgets = input.budgets.filter((budget) => budget.amount > 0 && categories.has(budget.categoryId));
  const exceededBudgets = normalBudgets.flatMap((budget) => {
    const spent = categoryTotals.get(budget.categoryId) ?? 0;
    const category = categories.get(budget.categoryId)!;
    return spent > budget.amount ? [{
      categoryId: budget.categoryId,
      name: category.name,
      icon: category.icon,
      categoryType: category.type,
      amount: spent,
      percent: Math.round((spent / budget.amount) * 100),
      overBy: spent - budget.amount,
    }] : [];
  });
  return {
    payload: {
      kind: 'monthly',
      monthStart: range.start,
      income,
      expense,
      unconvertedCount,
      topCategories: expenseCategories.slice(0, 3),
      budgetsOk: normalBudgets.length - exceededBudgets.length,
      budgetsTotal: normalBudgets.length,
      exceededBudgets,
      subscriptionsTotal,
      premiumUpsell: !input.premium,
    },
    stateKey,
  };
}
