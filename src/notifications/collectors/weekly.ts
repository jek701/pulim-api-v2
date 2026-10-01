import type { Category, Transaction } from '../../domain/types';
import { dateKey, previousWeekRange } from '../schedule';
import type { NotificationState, WeeklyPayload } from '../types';

function baseValue(transaction: Transaction): number | null {
  if (transaction.currency === 'UZS') return transaction.amount;
  return typeof transaction.baseAmount === 'number' ? transaction.baseAmount : null;
}

export function collectWeekly(input: {
  now: number;
  timeZone: string;
  transactions: Transaction[];
  categories: Category[];
  state: NotificationState;
}): { payload: WeeklyPayload; stateKey: string; empty: boolean } | null {
  const range = previousWeekRange(input.now, input.timeZone);
  const stateKey = `weekly:${dateKey(range.start, input.timeZone)}`;
  if (input.state.seen[stateKey]) return null;
  const previousStart = range.start - 7 * 86_400_000;
  const rows = input.transactions.filter((row) => row.date >= range.start && row.date < range.end && row.source !== 'transfer');
  const previousRows = input.transactions.filter((row) => row.date >= previousStart && row.date < range.start && row.source !== 'transfer');
  const empty = rows.length === 0;
  if (empty && input.state.weeklyEmptyStreak >= 2) return null;

  let income = 0;
  let expense = 0;
  let previousExpense = 0;
  let unconvertedCount = 0;
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
    }
  }
  for (const row of previousRows) {
    const value = baseValue(row);
    if (value === null) continue;
    if (row.source === 'return') previousExpense -= value;
    else if (row.type === 'expense') previousExpense += value;
  }
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const topCategories = [...categoryTotals.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .flatMap(([categoryId, amount]) => {
      const category = categories.get(categoryId);
      return category ? [{
        categoryId,
        name: category.name,
        icon: category.icon,
        categoryType: category.type,
        amount,
      }] : [];
    });
  const expenseChangePercent = previousExpense > 0
    ? Math.round(((expense - previousExpense) / previousExpense) * 100)
    : null;
  return {
    payload: {
      kind: 'weekly', from: range.start, to: range.end - 1, income, expense,
      operationCount: rows.length, unconvertedCount, expenseChangePercent, topCategories, empty,
    },
    stateKey,
    empty,
  };
}
