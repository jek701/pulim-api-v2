import type { Transaction, Category, Subcategory, Card } from '../../domain/types';
import { safeText } from '../../prompts/buildContext';
import { DAY, dayKey, dayMs, dateTime, days, weekday, hour, weekKey, monthKey } from './time';
export interface Filters {
  date_from: string;
  date_to: string;
  kind: 'expense' | 'income' | null;
  category_ids: string[] | null;
  exclude_category_ids: string[] | null;
  account_ids: string[] | null;
  weekdays: number[] | null;
  hour_from: number | null;
  hour_to: number | null;
  text_query: string | null;
  exclude_text: string | null;
  min_amount_uzs: number | null;
  max_amount_uzs: number | null;
}
export const GROUPS = [
  'none',
  'day',
  'week',
  'month',
  'weekday',
  'hour',
  'category',
  'subcategory',
  'account',
  'merchant',
] as const;
export type GroupBy = (typeof GROUPS)[number];
export interface Lookups {
  categories: Category[];
  subcategories: Subcategory[];
  accounts: Card[];
}
export const emptyFilters = (
  from: string,
  to: string,
  kind: Filters['kind'] = 'expense',
): Filters => ({
  date_from: from,
  date_to: to,
  kind,
  category_ids: null,
  exclude_category_ids: null,
  account_ids: null,
  weekdays: null,
  hour_from: null,
  hour_to: null,
  text_query: null,
  exclude_text: null,
  min_amount_uzs: null,
  max_amount_uzs: null,
});
export const amountUzs = (
  t: Pick<Transaction, 'currency' | 'amount' | 'baseAmount'>,
): number | null => {
  const n = t.currency === 'UZS' ? t.amount : t.baseAmount;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
export const financialKind = (t: Transaction): 'income' | 'expense' =>
  t.source === 'return' ? 'expense' : t.type;
export const signedAmount = (t: Transaction): number | null => {
  const n = amountUzs(t);
  return n === null ? null : t.source === 'return' ? -n : n;
};
export function merchant(t: Transaction): string {
  // Older capture metadata has only merchantTin; newer callers may supply merchant.
  const capture = t.capture as
    | (Transaction['capture'] & { merchant?: { name?: string } })
    | undefined;
  const name = capture?.merchant?.name?.trim() || t.sourceLabel?.trim();
  return safeText(name || t.comment?.trim().slice(0, 40).toLocaleLowerCase() || '—', 120);
}
const includesId = (ids: string[], t: Transaction) =>
  ids.includes(t.categoryId) || (!!t.subcategoryId && ids.includes(t.subcategoryId));
export function selectTransactions(transactions: Transaction[], f: Filters): Transaction[] {
  const from = dayMs(f.date_from),
    to = dayMs(f.date_to) + DAY - 1;
  // Canonical: pulim-ui-v2/src/pages/Charts.tsx (monthTxs/totalIncome/totalExpense),
  // src/pages/Transactions.tsx (analyticsTxs/summaryTotals), utils/transactionKind.ts.
  // Returns offset expense on the RETURN date; returnedAmount is display-only on
  // the original row. Subtracting it here would count the refund twice.
  return transactions.filter((t) => {
    if (t.scope === 'household' || t.source === 'transfer' || t.date < from || t.date > to)
      return false;
    if (f.kind && financialKind(t) !== f.kind) return false;
    if (f.category_ids && !includesId(f.category_ids, t)) return false;
    if (f.exclude_category_ids && includesId(f.exclude_category_ids, t)) return false;
    if (f.account_ids && !f.account_ids.includes(t.cardId ?? '')) return false;
    if (f.weekdays && !f.weekdays.includes(weekday(t.date))) return false;
    if (f.hour_from !== null && hour(t.date) < f.hour_from) return false;
    if (f.hour_to !== null && hour(t.date) > f.hour_to) return false;
    const text = `${t.comment ?? ''} ${merchant(t)} ${t.sourceLabel ?? ''}`.toLocaleLowerCase();
    if (f.text_query && !text.includes(f.text_query.toLocaleLowerCase())) return false;
    if (f.exclude_text && text.includes(f.exclude_text.toLocaleLowerCase())) return false;
    const amount = amountUzs(t);
    if (f.min_amount_uzs !== null && (amount === null || amount < f.min_amount_uzs)) return false;
    if (f.max_amount_uzs !== null && (amount === null || amount > f.max_amount_uzs)) return false;
    return true;
  });
}
const round = Math.round;
const avg = (sum: number, n: number) => (n ? round(sum / n) : 0);
export function spendingStats(
  transactions: Transaction[],
  f: Filters,
  groupBy: GroupBy,
  topN = 12,
  lookup: Lookups = { categories: [], subcategories: [], accounts: [] },
) {
  const selected = selectTransactions(transactions, f);
  const converted = selected.filter((t) => signedAmount(t) !== null);
  const values = converted.map((t) => signedAmount(t)!).sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0),
    count = values.length;
  const calendar = days(f.date_from, f.date_to);
  const matching = calendar.filter((d) => !f.weekdays || f.weekdays.includes(weekday(dayMs(d))));
  const groupKey = (t: Transaction): string => {
    switch (groupBy) {
      case 'day':
        return dayKey(t.date);
      case 'week':
        return weekKey(t.date);
      case 'month':
        return monthKey(t.date);
      case 'weekday':
        return String(weekday(t.date));
      case 'hour':
        return String(hour(t.date)).padStart(2, '0');
      case 'category':
        return t.categoryId;
      case 'subcategory':
        return t.subcategoryId ?? '—';
      case 'account':
        return t.cardId ?? '—';
      case 'merchant':
        return merchant(t);
      default:
        return 'all';
    }
  };
  const grouped = new Map<string, { sum: number; count: number }>();
  if (groupBy !== 'none')
    for (const t of converted) {
      const key = groupKey(t),
        g = grouped.get(key) ?? { sum: 0, count: 0 };
      g.sum += signedAmount(t)!;
      g.count++;
      grouped.set(key, g);
    }
  const label = (key: string) =>
    safeText(
      (groupBy === 'category'
        ? lookup.categories
        : groupBy === 'subcategory'
          ? lookup.subcategories
          : groupBy === 'account'
            ? lookup.accounts
            : []
      ).find((x) => x.id === key)?.name ?? key,
    );
  const groups = [...grouped].map(([key, g]) => {
    const n = matching.filter((d) => {
      const ms = dayMs(d);
      if (groupBy === 'day') return d === key;
      if (groupBy === 'week') return weekKey(ms) === key;
      if (groupBy === 'month') return monthKey(ms) === key;
      if (groupBy === 'weekday') return String(weekday(ms)) === key;
      return true;
    }).length;
    return {
      key,
      label: label(key),
      sum: round(g.sum),
      count: g.count,
      avg_per_transaction: avg(g.sum, g.count),
      matching_days: n,
      avg_per_matching_day: avg(g.sum, n),
      share_pct: sum ? Math.round((g.sum / sum) * 10000) / 100 : 0,
    };
  });
  const timeGroup = ['day', 'week', 'month', 'weekday', 'hour'].includes(groupBy);
  groups.sort((a, b) =>
    timeGroup ? a.key.localeCompare(b.key) : b.sum - a.sum || a.key.localeCompare(b.key),
  );
  const unconverted = selected.length - converted.length;
  return {
    period: {
      from: f.date_from,
      to: f.date_to,
      calendar_days: calendar.length,
      matching_days: matching.length,
      days_with_transactions: new Set(converted.map((t) => dayKey(t.date))).size,
    },
    totals: {
      sum: round(sum),
      count,
      avg_per_transaction: avg(sum, count),
      avg_per_matching_day: avg(sum, matching.length),
      median_transaction: count
        ? round((values[Math.floor((count - 1) / 2)] + values[Math.floor(count / 2)]) / 2)
        : 0,
      min: count ? round(values[0]) : 0,
      max: count ? round(values[count - 1]) : 0,
    },
    groups: groups.slice(0, topN),
    truncated: groups.length > topN,
    unconverted_count: unconverted,
    notes: [
      ...(unconverted ? ['Rows without a saved UZS conversion were excluded from sums.'] : []),
      ...(f.hour_from !== null || f.hour_to !== null
        ? ['Manually entered rows may not carry a meaningful time.']
        : []),
    ],
  };
}
export function transactionRow(t: Transaction, lookup: Lookups) {
  const name = (rows: { id: string; name: string }[], id?: string) =>
    safeText(rows.find((x) => x.id === id)?.name ?? id ?? '—');
  return {
    date: dateTime(t.date),
    kind: financialKind(t),
    amount: t.amount,
    currency: t.currency,
    amount_uzs: signedAmount(t) === null ? null : round(signedAmount(t)!),
    category: name(lookup.categories, t.categoryId),
    subcategory: name(lookup.subcategories, t.subcategoryId),
    account: name(lookup.accounts, t.cardId),
    merchant: merchant(t),
    comment: safeText(t.comment, 80),
  };
}
