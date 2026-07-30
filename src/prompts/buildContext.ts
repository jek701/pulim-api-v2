import dayjs from 'dayjs';
import { plannedAppliesToDay } from '../domain/recurrence';
import type {
  Transaction,
  UserProfile,
  Subscription,
  PlannedExpense,
  Category,
  Card,
  Debt,
  SavingsGoal,
  BillingCycle,
} from '../domain/types';

export interface ChatContext {
  profile?: UserProfile | null;
  transactions: Transaction[]; // already filtered to last 90 days
  categories: Category[];
  cards: Card[];
  subscriptions?: Subscription[];
  plannedExpenses?: PlannedExpense[];
  debts?: Debt[];
  savingsGoals?: SavingsGoal[];
  language: string;
}

const safeText = (value: unknown, maxLength = 120): string =>
  Array.from(String(value ?? ''))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

/** Amount normalized to UZS at transaction time, when that value is available. */
function transactionAmountUzs(transaction: Transaction): number | null {
  if (transaction.currency === 'UZS') return transaction.amount;
  return typeof transaction.baseAmount === 'number' && Number.isFinite(transaction.baseAmount)
    ? transaction.baseAmount
    : null;
}

/** Build a compact, calculation-first snapshot; raw user text remains explicitly untrusted. */
export function buildContextSnapshot(ctx: ChatContext): string {
  const lines: string[] = [];
  const today = dayjs();
  lines.push(`<financial_data>`);
  lines.push(`# Financial context`);
  lines.push(`Today: ${today.format('YYYY-MM-DD')}`);
  lines.push(`Base currency: UZS (Uzbek Som)`);
  lines.push('');

  if (ctx.profile) {
    lines.push(`## Profile`);
    if (ctx.profile.salarySources?.length) {
      for (const s of ctx.profile.salarySources) {
        lines.push(
          `- Salary "${safeText(s.name)}": day ${s.day} of month${s.amount ? ` (~${s.amount.toLocaleString()} UZS)` : ''}`,
        );
      }
    }
    if (ctx.profile.financialGoals?.length) {
      lines.push(`- Goals: ${ctx.profile.financialGoals.map((goal) => safeText(goal)).join(', ')}`);
    }
    if (ctx.profile.familyMembers?.length) {
      lines.push(`- Family: ${ctx.profile.familyMembers.map((m) => `${safeText(m.name)} (${m.relation})`).join('; ')}`);
    }
    lines.push('');
  }

  const catName = (id: string) => safeText(ctx.categories.find((c) => c.id === id)?.name ?? id);

  if (ctx.cards.length) {
    lines.push(`## Accounts`);
    for (const c of ctx.cards) {
      lines.push(
        `- ${safeText(c.name)} (${safeText(c.bank)}, ${c.cardType}, ${c.currency}) — balance: ${c.balance.toLocaleString()} ${c.currency}`,
      );
    }
    lines.push('');
  }

  const txs = [...ctx.transactions]
    .filter((transaction) => transaction.source !== 'transfer')
    .sort((a, b) => a.date - b.date);
  const normalized = txs.filter((transaction) => transactionAmountUzs(transaction) !== null);
  const unconvertedCount = txs.length - normalized.length;

  type MonthSummary = { income: number; expense: number; count: number };
  const monthly = new Map<string, MonthSummary>();
  const categoryExpense = new Map<string, number>();
  const currentMonth = today.format('YYYY-MM');
  for (const transaction of normalized) {
    const amount = transactionAmountUzs(transaction)!;
    const month = dayjs(transaction.date).format('YYYY-MM');
    const summary = monthly.get(month) ?? { income: 0, expense: 0, count: 0 };
    summary[transaction.type] += amount;
    summary.count += 1;
    monthly.set(month, summary);
    if (month === currentMonth && transaction.type === 'expense') {
      categoryExpense.set(transaction.categoryId, (categoryExpense.get(transaction.categoryId) ?? 0) + amount);
    }
  }

  lines.push(`## Calculated activity summary`);
  if (txs.length) {
    lines.push(
      `Coverage: ${dayjs(txs[0].date).format('YYYY-MM-DD')} to ${dayjs(txs[txs.length - 1].date).format('YYYY-MM-DD')}; ${txs.length} non-transfer transactions; ${unconvertedCount} without a saved UZS value.`,
    );
  } else {
    lines.push(`No non-transfer transactions in the supplied period.`);
  }
  for (const [month, summary] of [...monthly.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 12)) {
    const net = summary.income - summary.expense;
    lines.push(
      `- ${month}: income ${Math.round(summary.income).toLocaleString()} UZS; expenses ${Math.round(summary.expense).toLocaleString()} UZS; net ${Math.round(net).toLocaleString()} UZS; ${summary.count} transactions`,
    );
  }
  const topCategories = [...categoryExpense.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (topCategories.length) {
    lines.push(`Current-month expense categories:`);
    for (const [categoryId, amount] of topCategories) {
      lines.push(`- ${catName(categoryId)}: ${Math.round(amount).toLocaleString()} UZS`);
    }
  }
  lines.push('');

  const recent = txs.slice(-80).reverse();
  lines.push(`## Recent transaction evidence (${recent.length} newest non-transfer rows)`);
  for (const t of recent) {
    const d = dayjs(t.date).format('YYYY-MM-DD HH:mm');
    const sign = t.type === 'income' ? '+' : '-';
    const cat = safeText(t.sourceLabel ?? catName(t.categoryId));
    const uzs = transactionAmountUzs(t);
    let line = `${d} ${sign}${t.amount.toLocaleString()} ${t.currency} ${cat}`;
    if (t.currency !== 'UZS' && uzs !== null) line += ` (~${Math.round(uzs).toLocaleString()} UZS at transaction time)`;
    if (t.toAmount && t.toCurrency && t.toCurrency !== t.currency) line += ` -> ${t.toAmount} ${t.toCurrency}`;
    if (t.comment) line += ` // user note: ${safeText(t.comment, 160)}`;
    lines.push(line);
  }
  lines.push('');

  if (ctx.subscriptions?.length) {
    const active = ctx.subscriptions.filter((s) => s.isActive);
    lines.push(`## Active subscriptions (${active.length})`);
    for (const s of active) {
      const days = Math.ceil((s.nextBillingDate - Date.now()) / 86_400_000);
      lines.push(`- ${safeText(s.name)}: ${s.amount} ${s.currency}/${s.cycle}, next charge in ${days}d (${dayjs(s.nextBillingDate).format('YYYY-MM-DD')})`);
    }
    lines.push('');
  }

  if (ctx.plannedExpenses?.length) {
    lines.push(`## Calendar (planned items, next 30 days)`);
    const now = new Date();
    let count = 0;
    for (let i = 0; i < 30 && count < 60; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      for (const pe of ctx.plannedExpenses) {
        if (!plannedAppliesToDay(pe, d)) continue;
        const sign = pe.kind === 'income' ? '+' : '-';
        lines.push(`${dayjs(d).format('YYYY-MM-DD')}: ${safeText(pe.name)} ${sign}${pe.amount} ${pe.currency}`);
        count++;
      }
    }
    lines.push('');
  }

  if (ctx.debts?.length) {
    const unpaid = ctx.debts.filter((d) => !d.isPaid);
    if (unpaid.length) {
      lines.push(`## Active debts`);
      for (const d of unpaid) {
        const dir = d.direction === 'i_owe' ? 'I owe' : 'owed to me';
        lines.push(
          `- ${dir} ${safeText(d.person)}: ${(d.amount - d.paidAmount).toLocaleString()} ${d.currency} remaining${d.dueDate ? ` (due ${dayjs(d.dueDate).format('YYYY-MM-DD')})` : ''}`,
        );
      }
      lines.push('');
    }
  }

  if (ctx.savingsGoals?.length) {
    lines.push(`## Savings goals`);
    for (const g of ctx.savingsGoals) {
      const pct = g.targetAmount > 0 ? ((g.savedAmount / g.targetAmount) * 100).toFixed(1) : '0';
      lines.push(`- ${g.icon} ${safeText(g.name)}: ${g.savedAmount.toLocaleString()} / ${g.targetAmount.toLocaleString()} ${g.currency} (${pct}%)`);
    }
    lines.push('');
  }

  lines.push(`</financial_data>`);
  return lines.join('\n');
}

// ── Forecast prompt (ported from `ai.ts` getBudgetForecast) ───────────────────

const toMonthly = (amount: number, cycle: BillingCycle) => {
  if (cycle === 'weekly') return (amount * 52) / 12;
  if (cycle === 'yearly') return amount / 12;
  return amount;
};

function buildSubscriptionsContext(subscriptions?: Subscription[] | null): string {
  const active = subscriptions?.filter((s) => s.isActive);
  if (!active?.length) return '';
  const today = Date.now();
  const totalMonthlyUzs = active
    .filter((subscription) => subscription.currency === 'UZS')
    .reduce((sum, subscription) => sum + toMonthly(subscription.amount, subscription.cycle), 0);
  const upcoming = active.filter((s) => {
    const days = Math.ceil((s.nextBillingDate - today) / 86400000);
    return days >= 0 && days <= 14;
  });
  const lines = [`Active subscriptions (UZS-denominated total ~${Math.round(totalMonthlyUzs).toLocaleString()} UZS/month):`];
  for (const s of active) {
    const days = Math.ceil((s.nextBillingDate - today) / 86400000);
    const due = days < 0 ? `overdue by ${Math.abs(days)}d` : days === 0 ? 'due today' : `due in ${days}d`;
    lines.push(`  - ${s.name}: ${s.amount.toLocaleString()} ${s.currency}/${s.cycle} (${due})`);
  }
  if (upcoming.length) {
    lines.push(`Note: ${upcoming.length} subscription(s) will be charged in the next 14 days — factor these into spending forecasts.`);
  }
  return lines.join('\n');
}

function buildProfileContext(profile?: UserProfile | null): string {
  if (!profile) return '';
  const lines: string[] = [];
  const today = new Date();
  lines.push(`User profile:`);
  if (profile.salarySources?.length) {
    for (const s of profile.salarySources) {
      let line = `- Income source "${safeText(s.name)}": arrives on day ${s.day} of each month`;
      if (s.amount) line += ` (~${s.amount.toLocaleString()} UZS)`;
      line += ` — spending right after day ${s.day} is likely planned post-salary, not overspending`;
      lines.push(line);
    }
  }
  if (profile.birthday) {
    const bday = new Date(profile.birthday);
    const next = new Date(today.getFullYear(), bday.getMonth(), bday.getDate());
    if (next < today) next.setFullYear(today.getFullYear() + 1);
    const daysUntil = Math.ceil((next.getTime() - today.getTime()) / 86400000);
    lines.push(`- User's birthday in ${daysUntil} days (${profile.birthday})`);
  }
  if (profile.familyMembers?.length) {
    const memberLines = profile.familyMembers.map((m) => {
      let s = `${safeText(m.name)} (${m.relation})`;
      if (m.birthday) {
        const bday = new Date(m.birthday);
        const next = new Date(today.getFullYear(), bday.getMonth(), bday.getDate());
        if (next < today) next.setFullYear(today.getFullYear() + 1);
        const days = Math.ceil((next.getTime() - today.getTime()) / 86400000);
        s += ` — birthday in ${days} days`;
      }
      return s;
    });
    lines.push(`- Family members: ${memberLines.join('; ')}`);
  }
  if (profile.financialGoals?.length) {
    const goalLabels: Record<string, string> = {
      emergency_fund: 'build emergency fund',
      pay_debts: 'pay off debts faster',
      save_vacation: 'save for vacation',
      buy_home: 'buy a home',
      reduce_spending: 'reduce daily spending',
      save_education: 'save for education',
      invest: 'start investing',
      retirement: 'save for retirement',
    };
    const goals = profile.financialGoals.map((g) => goalLabels[g] ?? g).join(', ');
    lines.push(`- Financial goals: ${goals}`);
  }
  return lines.join('\n');
}

function plannedExpensesToContext(plannedExpenses: PlannedExpense[], daysAhead = 30): string {
  const today = new Date();
  const lines: string[] = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    for (const pe of plannedExpenses) {
      if (!plannedAppliesToDay(pe, d)) continue;
      const label = dayjs(d).format('MMM D');
      const sign = pe.kind === 'income' ? '+' : '-';
      lines.push(`  ${label}: ${safeText(pe.name)} ${sign}${pe.amount.toLocaleString()} ${pe.currency}`);
    }
  }
  if (lines.length === 0) return '';
  return `Scheduled upcoming planned items (next ${daysAhead} days, +income / -expense):\n${lines.slice(0, 20).join('\n')}\n`;
}

export interface ForecastInput {
  currentMonthTransactions: Transaction[];
  historicalTransactions: Transaction[];
  budgets: { categoryId: string; amount: number }[];
  categories: { id: string; name: string }[];
  incomeBudget: number;
  profile?: UserProfile | null;
  subscriptions?: Subscription[] | null;
  plannedExpenses?: PlannedExpense[] | null;
  language: string;
}

export function buildForecastPrompt(input: ForecastInput): string {
  const { currentMonthTransactions, historicalTransactions, budgets, categories, incomeBudget } = input;
  const now = new Date();
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - daysElapsed;
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Unknown';

  const spentByCategory: Record<string, number> = {};
  let totalSpent = 0;
  let totalIncome = 0;
  for (const t of currentMonthTransactions) {
    if (t.source === 'transfer') continue;
    const amount = transactionAmountUzs(t);
    if (amount === null) continue;
    if (t.type === 'expense') {
      spentByCategory[t.categoryId] = (spentByCategory[t.categoryId] ?? 0) + amount;
      totalSpent += amount;
    } else {
      totalIncome += amount;
    }
  }
  const dailyRate = daysElapsed > 0 ? totalSpent / daysElapsed : 0;
  const projectedTotal = Math.round(dailyRate * daysInMonth);

  type MonthSummary = { label: string; income: number; expense: number; byCategory: Record<string, number>; txCount: number };
  const prevMonths: MonthSummary[] = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = d.getMonth();
    const y = d.getFullYear();
    const label = dayjs(d).format('MMMM YYYY');
    const mTx = historicalTransactions.filter((t) => {
      const td = new Date(t.date);
      return td.getMonth() === m && td.getFullYear() === y && t.source !== 'transfer' && transactionAmountUzs(t) !== null;
    });
    if (mTx.length === 0) continue;
    const income = mTx
      .filter((t) => t.type === 'income')
      .reduce((sum, transaction) => sum + transactionAmountUzs(transaction)!, 0);
    const expense = mTx
      .filter((t) => t.type === 'expense')
      .reduce((sum, transaction) => sum + transactionAmountUzs(transaction)!, 0);
    const byCategory: Record<string, number> = {};
    for (const t of mTx.filter((t) => t.type === 'expense')) {
      byCategory[t.categoryId] = (byCategory[t.categoryId] ?? 0) + transactionAmountUzs(t)!;
    }
    prevMonths.push({ label, income, expense, byCategory, txCount: mTx.length });
  }

  const avgByCategory: Record<string, number> = {};
  if (prevMonths.length > 0) {
    const allCatIds = new Set(prevMonths.flatMap((m) => Object.keys(m.byCategory)));
    for (const catId of allCatIds) {
      const vals = prevMonths.map((m) => m.byCategory[catId] ?? 0);
      avgByCategory[catId] = Math.round(vals.reduce((s, v) => s + v, 0) / prevMonths.length);
    }
  }

  let historicalCtx = '';
  if (prevMonths.length > 0) {
    const avgIncome = Math.round(prevMonths.reduce((s, m) => s + m.income, 0) / prevMonths.length);
    const avgExpense = Math.round(prevMonths.reduce((s, m) => s + m.expense, 0) / prevMonths.length);
    historicalCtx = `Historical data (${prevMonths.length} month${prevMonths.length > 1 ? 's' : ''} prior, UZS only):\n`;
    historicalCtx += `Avg monthly income: ${avgIncome.toLocaleString()} UZS | Avg monthly expenses: ${avgExpense.toLocaleString()} UZS\n`;
    for (const m of prevMonths) {
      historicalCtx += `\n${m.label} (${m.txCount} transactions):\n`;
      historicalCtx += `  Income: ${m.income.toLocaleString()} | Expenses: ${m.expense.toLocaleString()} UZS\n`;
      const top = Object.entries(m.byCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([id, amt]) => `    ${catName(id)}: ${amt.toLocaleString()}`)
        .join('\n');
      if (top) historicalCtx += top + '\n';
    }
    historicalCtx += '\n';
  }

  const categoryLines = budgets
    .filter((b) => b.categoryId !== '__income__' && b.amount > 0)
    .map((b) => {
      const spent = spentByCategory[b.categoryId] ?? 0;
      const projected = daysElapsed > 0 ? Math.round((spent / daysElapsed) * daysInMonth) : 0;
      const avg = avgByCategory[b.categoryId];
      const status =
        projected > b.amount
          ? 'OVER BUDGET'
          : projected > b.amount * 0.8
            ? 'close to limit'
            : avg && spent < avg * (daysElapsed / daysInMonth) * 0.7
              ? 'unusually low — check if spending shifted'
              : 'on track';
      let line = `  - ${catName(b.categoryId)}: ${spent.toLocaleString()} spent`;
      line += ` -> linear projection ${projected.toLocaleString()} / budget ${b.amount.toLocaleString()} UZS [${status}]`;
      if (avg) line += ` | 3-mo avg: ${avg.toLocaleString()} UZS`;
      return line;
    })
    .join('\n');

  const profileCtx = buildProfileContext(input.profile);
  const subsCtx = buildSubscriptionsContext(input.subscriptions);
  const plannedCtx = input.plannedExpenses?.length ? plannedExpensesToContext(input.plannedExpenses) : '';

  return `Produce a careful, data-driven month-end forecast using only the supplied facts. Reference actual numbers. Do not use Markdown because the response will be returned as structured JSON.

${profileCtx ? profileCtx + '\n\n' : ''}${historicalCtx}${subsCtx ? subsCtx + '\n\n' : ''}${plannedCtx ? plannedCtx + '\n' : ''}Current month — Day ${daysElapsed}/${daysInMonth} (${daysLeft} days left):
Income received: ${totalIncome.toLocaleString()} UZS${incomeBudget ? ` / target ${incomeBudget.toLocaleString()} UZS` : ''}
Spent so far: ${totalSpent.toLocaleString()} UZS
Daily rate: ${Math.round(dailyRate).toLocaleString()} UZS/day -> linear forecast: ${projectedTotal.toLocaleString()} UZS

Category tracking (with 3-month historical averages where available):
${categoryLines || '  No budget categories set'}

Send in selected by the user language: ${input.language}

Return a short summary, exactly 3 focused predictions, one concrete action for this week, and a confidence level:
1. Realistic month-end spend estimate — if history suggests the linear forecast is misleading, explain why with numbers.
2. Specific categories at risk, comparing historical average with current pace.
3. A relevant timing or cash-flow risk from subscriptions, planned items, income timing, or missing data.
Keep the combined text fields under 170 words. Use the requested language: ${input.language}.`;
}
