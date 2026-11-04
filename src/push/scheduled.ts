import type { Card, Category, Debt, Deposit, SavingsGoal, Subscription, Transaction, UserProfile } from '../domain/types';
import { calcDebtTotal } from '../domain/debt';
import { calcCurrentPrincipal, calcRemainingInterest } from '../domain/deposit';
import { collectMonthly } from '../notifications/collectors/monthly';
import { collectWeekly } from '../notifications/collectors/weekly';
import { formatDate, formatMoney } from '../notifications/format';
import {
  addLocalDays, calendarDayDifference, calendarParts, dateKey, dayStart, isoWeekKey,
  localWeekday, previousMonthRange, zonedTimestamp,
} from '../notifications/schedule';
import type { ScheduledPushCandidate, PushGroup, PushType } from './types';

export interface ScheduledPushSnapshot {
  profile: UserProfile;
  now: number;
  timeZone?: string;
  cards?: Array<Card & { minimumPayment?: number }>;
  subscriptions?: Array<Subscription & { accountId?: string }>;
  debts?: Debt[];
  deposits?: Deposit[];
  goals?: SavingsGoal[];
  transactions?: Transaction[];
  categories?: Category[];
}

function interestDay(deposit: Deposit, slot: number, timeZone: string): boolean {
  if (!deposit.showInterest || slot < dayStart(deposit.startDate, timeZone)
    || calendarDayDifference(slot, deposit.endDate, timeZone) > 0) return false;
  if (deposit.capitalization === 'at_end') return calendarDayDifference(deposit.endDate, slot, timeZone) === 0;
  const days = calendarDayDifference(slot, deposit.startDate, timeZone);
  if (days <= 0) return false;
  if (deposit.capitalization === 'custom') {
    const interval = deposit.customCapitalizationDays;
    return typeof interval === 'number' && interval > 0 && days % interval === 0;
  }
  const start = calendarParts(deposit.startDate, timeZone);
  const current = calendarParts(slot, timeZone);
  const months = (current.year - start.year) * 12 + current.month - start.month;
  const lastDay = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate();
  return months > 0 && current.day === Math.min(start.day, lastDay)
    && (deposit.capitalization === 'monthly' || months % 3 === 0);
}

/** Pure: snapshots are loaded by the planner; this module performs no storage or network calls. */
export function collectScheduledPushes(input: ScheduledPushSnapshot): ScheduledPushCandidate[] {
  const { profile, now } = input;
  const timeZone = input.timeZone ?? profile.notifications?.timezone ?? 'Asia/Tashkent';
  const language = profile.language ?? 'uz';
  const money = (amount: number, currency: string) => formatMoney(amount, currency, language);
  const date = (timestamp: number) => formatDate(timestamp, language, timeZone);
  const result: ScheduledPushCandidate[] = [];
  const personalTransactions = (input.transactions ?? []).filter(row => row.scope !== 'household');
  const cards = input.cards ?? [];
  const categories = input.categories ?? [];
  const localToday = dayStart(now, timeZone);

  for (let offset = 0; offset <= 1; offset += 1) {
    const day = addLocalDays(localToday, offset, timeZone);
    const parts = calendarParts(day, timeZone);
    const runAt = zonedTimestamp({ ...parts, hour: 10, minute: 0, second: 0 }, timeZone);
    const dayKey = dateKey(day, timeZone);
    const append = (type: PushType, group: PushGroup, entityId: string | undefined, link: string,
      values: Record<string, string | number>, occurrence: string, scheduledAt = runAt) => {
      const dedupeKey = `push:${type}:${entityId ?? 'user'}:${occurrence}`;
      if (result.some(candidate => candidate.dedupeKey === dedupeKey)) return;
      result.push({ type, group, ...(entityId ? { entityId } : {}), link, values, eventAt: now,
        runAt: scheduledAt, dedupeKey });
    };

    for (const subscription of input.subscriptions ?? []) {
      if (!subscription.isActive || calendarDayDifference(subscription.nextBillingDate, day, timeZone) !== 0) continue;
      const account = cards.find(card => card.id === subscription.accountId)?.name
        ?? { ru: 'счёта подписки', uz: 'obuna', en: 'your subscription account' }[language];
      append('subscription_due', 'money', subscription.id, `/subscriptions/${encodeURIComponent(subscription.id)}`,
        { name: subscription.name, amount: money(subscription.amount, subscription.currency), account },
        dateKey(subscription.nextBillingDate, timeZone));
    }

    for (const debt of input.debts ?? []) {
      if (debt.isPaid || typeof debt.dueDate !== 'number') continue;
      const remaining = Math.max(0, calcDebtTotal(debt.amount, debt.commission) - Number(debt.paidAmount ?? 0));
      if (remaining <= 0) continue;
      const difference = calendarDayDifference(debt.dueDate, day, timeZone);
      const type = difference === 3 ? 'debt_3d' : difference === 0 ? 'debt_due' : difference < 0 ? 'debt_overdue' : null;
      if (!type) continue;
      const dueKey = dateKey(debt.dueDate, timeZone);
      append(type, 'money', debt.id, `/debts/${encodeURIComponent(debt.id)}`,
        { person: debt.person, amount: money(remaining, debt.currency), date: date(debt.dueDate), days: -difference },
        type === 'debt_overdue' ? `${dueKey}:${isoWeekKey(day, timeZone)}` : dueKey);
    }

    const cardDue = addLocalDays(day, 2, timeZone);
    const dueParts = calendarParts(cardDue, timeZone);
    const dueLastDay = new Date(Date.UTC(dueParts.year, dueParts.month, 0)).getUTCDate();
    for (const card of cards) {
      if (card.scope === 'household' || card.cardType !== 'credit' || !card.dueDay || card.balance <= 0
        || Math.min(card.dueDay, dueLastDay) !== dueParts.day) continue;
      // The current Card model has no minimum payment: never present its balance as that amount.
      const amount = typeof card.minimumPayment === 'number' ? money(card.minimumPayment, card.currency) : '—';
      append('credit_card_due', 'money', card.id, `/accounts/${encodeURIComponent(card.id)}`,
        { name: card.name, amount, date: date(cardDue) }, dateKey(cardDue, timeZone));
    }

    for (const deposit of input.deposits ?? []) {
      if (deposit.isClosed) continue;
      if (calendarDayDifference(deposit.endDate, day, timeZone) === 7) {
        append('deposit_ending', 'money', deposit.id, `/accounts/${encodeURIComponent(deposit.id)}`,
          { name: deposit.bank, amount: money(calcCurrentPrincipal(deposit), deposit.currency), date: date(deposit.endDate) },
          dateKey(deposit.endDate, timeZone));
      }
      if (interestDay(deposit, day, timeZone)) {
        const amount = calcRemainingInterest(deposit, runAt);
        if (amount > 0) append('deposit_interest', 'money', deposit.id, `/accounts/${encodeURIComponent(deposit.id)}`,
          { name: deposit.bank, amount: money(amount, deposit.currency) }, dayKey);
      }
    }

    for (const goal of input.goals ?? []) {
      if (goal.savedAmount >= goal.targetAmount || calendarDayDifference(goal.deadline, day, timeZone) !== 7) continue;
      append('goal_deadline', 'money', goal.id, `/goals/${encodeURIComponent(goal.id)}`,
        { name: goal.name, amount: money(Math.max(0, goal.targetAmount - goal.savedAmount), goal.currency) }, dateKey(goal.deadline, timeZone));
    }

    const premiumUntil = profile.subscription?.premiumUntil;
    if (typeof premiumUntil === 'number') {
      const difference = calendarDayDifference(premiumUntil, day, timeZone);
      if (profile.subscription?.isTrial && (difference === 1 || difference === 3)) {
        append('trial_ending', 'premium', undefined, '/premium', { days: difference }, `${premiumUntil}:${difference}`);
      }
      // Plan the first 10:00 after expiry, including tomorrow if expiry is later today.
      if (premiumUntil <= runAt && runAt - premiumUntil < 48 * 60 * 60_000) {
        append('premium_expired', 'premium', undefined, '/premium', {}, String(premiumUntil));
      }
    }

    const isMonthly = parts.day === 1;
    const isWeekly = !isMonthly && localWeekday(day, timeZone) === 1;
    if (isMonthly) {
      const monthly = collectMonthly({ now: runAt, timeZone, transactions: personalTransactions, categories,
        budgets: [], premium: false, seen: {} });
      if (monthly) {
        const { start } = previousMonthRange(day, timeZone);
        const locale = language === 'uz' ? 'uz-UZ' : language === 'ru' ? 'ru-RU' : 'en-GB';
        const month = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'long' })
          .formatToParts(new Date(start)).find(part => part.type === 'month')?.value ?? '';
        append('monthly_summary', 'habit', undefined, '/(tabs)/history',
          { income: money(monthly.payload.income, 'UZS'), expense: money(monthly.payload.expense, 'UZS'), month },
          dateKey(start, timeZone).slice(0, 7));
      }
    } else if (isWeekly) {
      const weekly = collectWeekly({ now: runAt, timeZone, transactions: personalTransactions, categories,
        state: { userId: '', seen: {}, trialAvailableSentCount: 0, lastTrialAvailableAt: null, weeklyEmptyStreak: 0, updatedAt: now } });
      if (weekly) {
        const change = weekly.payload.expenseChangePercent;
        let comparison = '';
        if (change !== null && change !== 0) {
          comparison = language === 'ru' ? `На ${Math.abs(change)}% ${change < 0 ? 'меньше' : 'больше'}, чем неделю назад`
            : language === 'uz' ? `O‘tgan haftadan ${Math.abs(change)}% ${change < 0 ? 'kam' : 'ko‘p'}`
              : `${Math.abs(change)}% ${change < 0 ? 'less' : 'more'} than the previous week`;
        }
        append('weekly_summary', 'habit', undefined, '/(tabs)/history', {
          expense: money(weekly.payload.expense, 'UZS'), category: weekly.payload.topCategories[0]?.name ?? '—', change: comparison,
        }, dateKey(weekly.payload.from, timeZone));
      }
    }

    const createdAt = profile.createdAt;
    const age = typeof createdAt === 'number' ? calendarDayDifference(day, createdAt, timeZone) : -1;
    // The habit group sends at most once per day; reports take precedence over the evening prompt.
    if (!isMonthly && !isWeekly && age >= 0 && age < 14
      && !personalTransactions.some(row => dateKey(row.date, timeZone) === dayKey)) {
      const evening = zonedTimestamp({ ...parts, hour: 21, minute: 0, second: 0 }, timeZone);
      append('evening_log', 'habit', undefined, '/(tabs)', {}, dayKey, evening);
    }
  }
  return result.sort((left, right) => left.runAt - right.runAt);
}

/** Rebuild from current records at send time: paid/deleted records and new daily entries suppress stale plans. */
export function refreshScheduledPush(
  candidate: Pick<ScheduledPushCandidate, 'dedupeKey'>,
  snapshot: ScheduledPushSnapshot,
): ScheduledPushCandidate | null {
  return collectScheduledPushes(snapshot).find(current => current.dedupeKey === candidate.dedupeKey) ?? null;
}
