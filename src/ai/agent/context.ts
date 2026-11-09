import type { AgentDataSource } from './dataSource';
import { safeText } from '../../prompts/buildContext';
import { DAY, OFFSET, TIMEZONE, dayKey, dayMs, monthKey, monthRange, weekday } from './time';
import { emptyFilters, spendingStats } from './stats';
/** Conservative UTF-8 byte budget, including wrapper; lists explicitly truncated. */
export async function buildAgentContext(ds: AgentDataSource, now = Date.now()): Promise<string> {
  const today = dayKey(now),
    local = new Date(now + OFFSET);
  const first = dayKey(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 3, 1) - OFFSET);
  const [profile, accounts, categories, subcategories, txs, goals, debts, subscriptions] =
    await Promise.all([
      ds.profile(),
      ds.accounts(),
      ds.categories(),
      ds.subcategories(),
      ds.transactions(dayMs(first), dayMs(today) + DAY - 1),
      ds.savingsGoals(),
      ds.debts(),
      ds.subscriptions(),
    ]);
  const lines = [
    '<financial_data>',
    `Today: ${today}; ISO weekday ${weekday(now)}; timezone ${TIMEZONE}; base currency UZS.`,
  ];
  for (let i = 3; i >= 0; i--) {
    const month = monthKey(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - i, 1) - OFFSET);
    const range = monthRange(month),
      end = i === 0 ? today : range.to;
    const expense = spendingStats(txs, emptyFilters(range.from, end), 'none');
    const income = spendingStats(txs, emptyFilters(range.from, end, 'income'), 'none');
    lines.push(
      `${month}${i === 0 ? ' MTD' : ''}: income ${income.totals.sum}, expense ${expense.totals.sum} UZS; unconverted ${expense.unconverted_count + income.unconverted_count}.`,
    );
  }
  const active = subscriptions.filter((s) => s.isActive);
  const monthly = active
    .filter((s) => s.currency === 'UZS')
    .reduce(
      (n, s) => n + s.amount * (s.cycle === 'weekly' ? 52 / 12 : s.cycle === 'yearly' ? 1 / 12 : 1),
      0,
    );
  lines.push(
    `Active subscriptions: ${active.length}; monthly total UZS-denominated only ${Math.round(monthly)} UZS; unconverted ${active.filter((s) => s.currency !== 'UZS').length}.`,
  );
  let truncated = false;
  const add = (line: string) => {
    if (
      Buffer.byteLength(
        [
          ...lines,
          line,
          'Lists truncated: more data available via tools.',
          '</financial_data>',
        ].join('\n'),
      ) <= 5300
    )
      lines.push(line);
    else truncated = true;
  };
  // IDs are untrusted strings too; JSON quoting prevents line/field confusion.
  for (const c of categories)
    add(`Category ${JSON.stringify(safeText(c.id, 160))} ${c.type}: ${safeText(c.name, 60)}`);
  for (const c of subcategories)
    add(
      `Subcategory ${JSON.stringify(safeText(c.id, 160))} parent ${JSON.stringify(safeText(c.categoryId, 160))} ${categories.find((p) => p.id === c.categoryId)?.type ?? 'unknown'}: ${safeText(c.name, 60)}`,
    );
  for (const a of accounts.filter((a) => a.scope !== 'household'))
    add(
      `Account ${JSON.stringify(safeText(a.id, 160))}: ${safeText(a.name, 60)}, ${a.cardType}, ${a.balance} ${a.currency}`,
    );
  for (const s of profile?.salarySources ?? [])
    add(`Salary ${safeText(s.name, 60)}: day ${s.day}, ${s.amount ?? 'unknown'} UZS`);
  if (profile?.financialGoals?.length)
    add(`Priorities: ${profile.financialGoals.map((x) => safeText(x, 40)).join(', ')}`);
  const activeGoals = goals.filter((g) => g.savedAmount < g.targetAmount),
    activeDebts = debts.filter((d) => !d.isPaid);
  for (const g of activeGoals.slice(0, 10))
    add(
      `Goal ${safeText(g.name, 60)}: ${g.savedAmount}/${g.targetAmount} ${g.currency}, deadline ${dayKey(g.deadline)}`,
    );
  for (const d of activeDebts.slice(0, 10))
    add(
      `Debt ${d.direction} ${safeText(d.person, 60)}: remaining ${Math.round(d.amount - d.paidAmount)} ${d.currency}${d.dueDate ? `, due ${dayKey(d.dueDate)}` : ''}`,
    );
  if (truncated || activeGoals.length > 10 || activeDebts.length > 10)
    lines.push(
      'Lists truncated: some context entries omitted. Do not infer missing ids or amounts.',
    );
  lines.push('</financial_data>');
  return lines.join('\n');
}
