import { z } from 'zod';
import type { FunctionTool } from 'openai/resources/responses/responses';
import type { AgentDataSource } from './dataSource';
import type { PlannedExpense } from '../../domain/types';
import { plannedAppliesToDay } from '../../domain/recurrence';
import { safeText } from '../../prompts/buildContext';
import { calculate } from './calc';
import {
  GROUPS,
  amountUzs,
  emptyFilters,
  selectTransactions,
  signedAmount,
  spendingStats,
  transactionRow,
} from './stats';
import { DAY, dayKey, dayMs, days, monthKey, monthRange, validateRange } from './time';
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    try {
      dayMs(d);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid calendar date');
export const filterSchema = z
  .object({
    date_from: date,
    date_to: date,
    kind: z.enum(['expense', 'income']),
    category_ids: z.array(z.string()).nullable(),
    exclude_category_ids: z.array(z.string()).nullable(),
    account_ids: z.array(z.string()).nullable(),
    weekdays: z.array(z.number().int().min(1).max(7)).nullable(),
    hour_from: z.number().int().min(0).max(23).nullable(),
    hour_to: z.number().int().min(0).max(23).nullable(),
    text_query: z.string().nullable(),
    exclude_text: z.string().nullable(),
    min_amount_uzs: z.number().finite().nullable(),
    max_amount_uzs: z.number().finite().nullable(),
  })
  .strict();
export const argumentSchemas = {
  get_spending_stats: z
    .object({
      filters: filterSchema,
      group_by: z.enum(GROUPS),
      top_n: z.number().int().min(1).max(62).nullable(),
    })
    .strict(),
  find_transactions: z
    .object({
      filters: filterSchema,
      sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']),
      limit: z.number().int().min(1).max(30),
    })
    .strict(),
  get_budgets_status: z
    .object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .nullable(),
    })
    .strict(),
  get_upcoming: z.object({ days_ahead: z.number().int().min(1).max(90) }).strict(),
  calculate: z.object({ expression: z.string().min(1).max(300) }).strict(),
  get_transactions_digest: z
    .object({
      filters: filterSchema.extend({ kind: z.enum(['expense', 'income']).nullable() }).strict(),
      limit: z.number().int().min(1).max(300),
    })
    .strict(),
};
export type ToolName = keyof typeof argumentSchemas;
// Keep JSON schema and runtime validation derived from one source; refinements
// (real calendar dates, finite numbers and cross-field ranges) are checked below.
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodEffects) return jsonSchema(schema.innerType());
  if (schema instanceof z.ZodNullable) {
    const inner = jsonSchema(schema.unwrap());
    return {
      ...inner,
      type: [inner.type, 'null'],
      ...(inner.enum ? { enum: [...(inner.enum as string[]), null] } : {}),
    };
  }
  if (schema instanceof z.ZodObject) {
    const properties = Object.fromEntries(
      Object.entries(schema.shape).map(([k, v]) => [k, jsonSchema(v as z.ZodTypeAny)]),
    );
    return {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodArray) return { type: 'array', items: jsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodString)
    return {
      type: 'string',
      ...(schema.minLength !== null ? { minLength: schema.minLength } : {}),
      ...(schema.maxLength !== null ? { maxLength: schema.maxLength } : {}),
    };
  if (schema instanceof z.ZodNumber)
    return {
      type: schema.isInt ? 'integer' : 'number',
      ...(schema.minValue !== null ? { minimum: schema.minValue } : {}),
      ...(schema.maxValue !== null ? { maximum: schema.maxValue } : {}),
    };
  throw new Error('Unsupported tool schema');
}
const descriptions: Record<ToolName, string> = {
  get_spending_stats:
    'Server-computed personal income/expense statistics in UZS. Inclusive Tashkent dates, maximum 3 years. Category ids include their subcategories. Calendar-day averages include zero-spend days. Manually entered rows may not carry a meaningful time; use hour filters cautiously. Returns offset expense on their date.',
  find_transactions:
    'Find personal transactions. Amount sorting uses UZS (unconverted rows last). Manually entered rows may not carry a meaningful time.',
  get_budgets_status:
    'Category budgets, remaining UZS and income target versus actual. Null month means current Tashkent month. Non-UZS limits without conversion cannot be compared.',
  get_upcoming:
    'Subscriptions, recurring planned expenses/incomes and debts due in the next days_ahead Tashkent calendar days, including today; convertible UZS totals.',
  calculate:
    'Safe arithmetic: decimal numbers, + - * / ^ % (modulo), parentheses, unary minus, round(x[,digits]), min(...), max(...), abs(x). Use for every arithmetic step on tool numbers.',
  get_transactions_digest:
    'Fallback evidence for questions filters cannot express, compact pipe-separated personal rows. Nullable kind means both. Manually entered rows may not carry a meaningful time.',
};
export const toolDefinitions: FunctionTool[] = (Object.keys(argumentSchemas) as ToolName[]).map(
  (name) => ({
    type: 'function',
    name,
    description: descriptions[name],
    strict: true,
    parameters: jsonSchema(argumentSchemas[name]),
  }),
);
export async function lookups(ds: AgentDataSource) {
  const [categories, subcategories, accounts] = await Promise.all([
    ds.categories(),
    ds.subcategories(),
    ds.accounts(),
  ]);
  return { categories, subcategories, accounts };
}
// The shared recurrence helper reads host-local fields. Rebase calendar dates to
// host-local noon before invoking it, so expansion remains Tashkent-based on any host.
function calendarDate(ms: number): Date {
  const [y, m, d] = dayKey(ms).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
function plannedOn(pe: PlannedExpense, key: string): boolean {
  if (pe.skipped?.includes(key) || pe.paid?.[key]) return false;
  return plannedAppliesToDay(
    {
      ...pe,
      date: pe.date ? calendarDate(pe.date).getTime() : undefined,
      endDate: pe.endDate ? calendarDate(pe.endDate).getTime() : undefined,
    },
    calendarDate(dayMs(key)),
  );
}
export async function upcoming(ds: AgentDataSource, daysAhead: number, now: number) {
  const from = dayKey(now),
    to = dayKey(dayMs(from) + (daysAhead - 1) * DAY);
  const [subscriptions, planned, debts] = await Promise.all([
    ds.subscriptions(),
    ds.plannedExpenses(),
    ds.debts(),
  ]);
  const rows: {
    source: string;
    name: string;
    kind: string;
    amount: number;
    currency: string;
    date: string;
    amount_uzs: number | null;
  }[] = [];
  for (const s of subscriptions.filter((s) => s.isActive)) {
    // Advance from the saved due date, clamping month ends (Jan 31 -> Feb 28).
    const anchor = dayKey(s.nextBillingDate),
      dom = Number(anchor.slice(8));
    let key = anchor;
    for (let i = 0; key <= to && i < 10000; i++) {
      if (key >= from)
        rows.push({
          source: 'subscription',
          name: safeText(s.name),
          kind: 'expense',
          amount: s.amount,
          currency: s.currency,
          date: key,
          amount_uzs: amountUzs(s),
        });
      if (s.cycle === 'weekly') key = dayKey(dayMs(key) + 7 * DAY);
      else {
        const d = new Date(`${key}T12:00:00Z`);
        const m = d.getUTCMonth() + (s.cycle === 'yearly' ? 12 : 1),
          y = d.getUTCFullYear();
        key = new Date(
          Date.UTC(y, m, Math.min(dom, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()), 12),
        )
          .toISOString()
          .slice(0, 10);
      }
    }
  }
  for (const key of days(from, to))
    for (const pe of planned)
      if (plannedOn(pe, key))
        rows.push({
          source: 'planned',
          name: safeText(pe.name),
          kind: pe.kind ?? 'expense',
          amount: pe.amount,
          currency: pe.currency,
          date: key,
          amount_uzs: amountUzs(pe),
        });
  for (const d of debts)
    if (!d.isPaid && d.dueDate && dayKey(d.dueDate) >= from && dayKey(d.dueDate) <= to) {
      const amount = Math.max(0, d.amount - d.paidAmount);
      rows.push({
        source: 'debt',
        name: safeText(d.person),
        kind: d.direction === 'i_owe' ? 'expense' : 'income',
        amount,
        currency: d.currency,
        date: dayKey(d.dueDate),
        amount_uzs: amountUzs({ currency: d.currency, amount }),
      });
    }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const total = (kind: string) =>
    Math.round(rows.filter((r) => r.kind === kind).reduce((n, r) => n + (r.amount_uzs ?? 0), 0));
  return {
    period: { from, to },
    rows: rows.map((r) => ({
      ...r,
      amount_uzs: r.amount_uzs === null ? null : Math.round(r.amount_uzs),
    })),
    totals: { expense_uzs: total('expense'), income_uzs: total('income') },
    unconverted_count: rows.filter((r) => r.amount_uzs === null).length,
  };
}
export async function executeTool(
  name: string,
  raw: unknown,
  ds: AgentDataSource,
  now = Date.now(),
): Promise<any> {
  try {
    if (!Object.hasOwn(argumentSchemas, name)) return { error: 'Unknown tool' };
    const a = argumentSchemas[name as ToolName].parse(
      typeof raw === 'string' ? JSON.parse(raw) : raw,
    );
    if ('filters' in a) {
      const f = a.filters;
      validateRange(f.date_from, f.date_to, now);
      if (f.hour_from !== null && f.hour_to !== null && f.hour_from > f.hour_to)
        return { error: 'hour_from exceeds hour_to' };
      if (
        f.min_amount_uzs !== null &&
        f.max_amount_uzs !== null &&
        f.min_amount_uzs > f.max_amount_uzs
      )
        return { error: 'min_amount_uzs exceeds max_amount_uzs' };
      const [transactions, lookup] = await Promise.all([
        ds.transactions(dayMs(f.date_from), dayMs(f.date_to) + DAY - 1),
        lookups(ds),
      ]);
      if ('group_by' in a) return spendingStats(transactions, f, a.group_by, a.top_n ?? 12, lookup);
      const selected = selectTransactions(transactions, f);
      if ('sort' in a && typeof a.sort === 'string') {
        const sort = a.sort;
        selected.sort((x, y) => {
          if (sort.startsWith('date')) return (x.date - y.date) * (sort === 'date_desc' ? -1 : 1);
          const left = signedAmount(x),
            right = signedAmount(y);
          if (left === null) return right === null ? 0 : 1;
          if (right === null) return -1;
          return (left - right) * (sort === 'amount_desc' ? -1 : 1);
        });
        return {
          total_matching: selected.length,
          rows: selected.slice(0, a.limit).map((t) => transactionRow(t, lookup)),
        };
      }
      selected.sort((x, y) => x.date - y.date);
      const lines = selected.slice(0, a.limit).map((t) => {
        const row = transactionRow(t, lookup);
        return [
          row.date,
          row.kind === 'expense' ? 'exp' : 'inc',
          row.amount_uzs ?? 'unconverted',
          row.category,
          row.merchant,
          safeText(t.comment, 40),
        ]
          .map((v) => String(v).replace(/\|/g, ' '))
          .join('|');
      });
      return {
        lines: lines.join('\n'),
        total_matching: selected.length,
        truncated: selected.length > a.limit,
      };
    }
    if ('expression' in a) return calculate(a.expression);
    if ('days_ahead' in a) return upcoming(ds, a.days_ahead, now);
    if ('month' in a) {
      const range = monthRange(a.month ?? monthKey(now));
      validateRange(range.from, range.to, now);
      const [budgets, txs, lookup] = await Promise.all([
        ds.budgets(),
        ds.transactions(dayMs(range.from), dayMs(range.to) + DAY - 1),
        lookups(ds),
      ]);
      const daysLeft = Math.max(
        0,
        Math.min(
          days(range.from, range.to).length,
          Math.round((dayMs(range.to) - dayMs(dayKey(now))) / DAY),
        ),
      );
      const rows = budgets.map((b) => {
        const income = b.categoryId === '__income__';
        const f = emptyFilters(range.from, range.to, income ? 'income' : 'expense');
        if (!income) f.category_ids = [b.categoryId];
        const stats = spendingStats(txs, f, 'none');
        const limit = b.currency === 'UZS' ? Math.round(b.amount) : null;
        return {
          category: income
            ? '__income__'
            : safeText(lookup.categories.find((c) => c.id === b.categoryId)?.name ?? b.categoryId),
          limit,
          currency: b.currency,
          spent: stats.totals.sum,
          remaining: limit === null ? null : limit - stats.totals.sum,
          pct: limit ? Math.round((stats.totals.sum / limit) * 10000) / 100 : null,
          days_left_in_month: daysLeft,
          unconverted_count: stats.unconverted_count,
        };
      });
      return {
        month: a.month ?? monthKey(now),
        budgets: rows.filter((r) => r.category !== '__income__'),
        income_target: rows.find((r) => r.category === '__income__') ?? null,
      };
    }
    return { error: 'Invalid arguments' };
  } catch (e) {
    return {
      error:
        e instanceof z.ZodError
          ? 'Invalid tool arguments: ' +
            e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : e instanceof SyntaxError
            ? 'Invalid JSON arguments'
            : e instanceof Error && /date|range|YYYY|calendar/i.test(e.message)
              ? e.message
              : 'Tool could not read the requested data',
    };
  }
}
