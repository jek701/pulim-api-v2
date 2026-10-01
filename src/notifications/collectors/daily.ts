import { db } from '../../config/firebase';
import { env } from '../../config/env';
import type {
  Budget,
  Card,
  Category,
  Debt,
  Deposit,
  SavingsGoal,
  Subscription,
  Transaction,
  UserProfile,
} from '../../domain/types';
import { logger } from '../../utils/logger';
import { normalizeLanguage } from '../../telegram/i18n';
import { addMonthlyInsight, addWeeklyInsight } from '../ai';
import { calendarParts, localWeekday, previousMonthRange, previousWeekRange } from '../schedule';
import type { DailyPayload, NotificationState, NotificationStateEffects } from '../types';
import { collectEvents } from './events';
import { collectLifecycle } from './lifecycle';
import { collectMonthly } from './monthly';
import { collectWeekly } from './weekly';

async function listOwned<T>(collection: string, uid: string): Promise<T[]> {
  const snapshot = await db.collection(collection).where('userId', '==', uid).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as T);
}

async function listTransactions(uid: string, start: number, end: number): Promise<Transaction[]> {
  try {
    const snapshot = await db.collection('transactions')
      .where('userId', '==', uid)
      .where('date', '>=', start)
      .where('date', '<', end)
      .get();
    return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as Transaction);
  } catch (error) {
    logger.warn({ err: error, uid }, 'notify.transactions.index_fallback');
    const rows = await listOwned<Transaction>('transactions', uid);
    return rows.filter((row) => row.date >= start && row.date < end);
  }
}

export interface DailyCollection {
  payload: DailyPayload;
  stateKeys: string[];
  stateEffects: NotificationStateEffects;
  blockNames: string[];
}

export async function collectDaily(input: {
  uid: string;
  profile: UserProfile;
  state: NotificationState;
  now: number;
}): Promise<DailyCollection | null> {
  const { uid, profile, state, now } = input;
  const [subscriptions, debts, cards, deposits, goals] = await Promise.all([
    listOwned<Subscription>('subscriptions', uid),
    listOwned<Debt>('debts', uid),
    listOwned<Card>('cards', uid),
    listOwned<Deposit>('deposits', uid),
    listOwned<SavingsGoal>('savingsGoals', uid),
  ]);
  const lifecycle = collectLifecycle({
    uid,
    profile,
    state,
    now,
    timeZone: env.NOTIFY_TIMEZONE,
    cardCount: cards.length,
    trialAvailableDays: env.NOTIFY_TRIAL_AVAILABLE_DAYS,
    trialRepeatDays: env.NOTIFY_TRIAL_AVAILABLE_REPEAT_DAYS,
    noCardsDays: env.NOTIFY_NO_CARDS_DAYS,
  });
  const events = collectEvents({
    now,
    timeZone: env.NOTIFY_TIMEZONE,
    seen: state.seen,
    subscriptions,
    debts,
    cards,
    deposits,
    goals,
  });

  const parts = calendarParts(now, env.NOTIFY_TIMEZONE);
  const isMonthly = parts.day === 1;
  const isWeekly = !isMonthly && localWeekday(now, env.NOTIFY_TIMEZONE) === 1;
  const premium = profile.isPremium === true
    && typeof profile.subscription?.premiumUntil === 'number'
    && profile.subscription.premiumUntil > now;
  let report: DailyPayload['report'];
  let reportStateKey: string | null = null;
  let weeklyEmpty: boolean | undefined;
  if (isMonthly || isWeekly) {
    const range = isMonthly
      ? previousMonthRange(now, env.NOTIFY_TIMEZONE)
      : previousWeekRange(now, env.NOTIFY_TIMEZONE);
    const start = isMonthly ? range.start : range.start - 7 * 86_400_000;
    const [transactions, categories, budgets] = await Promise.all([
      listTransactions(uid, start, range.end),
      listOwned<Category>('categories', uid),
      isMonthly ? listOwned<Budget>('budgets', uid) : Promise.resolve([]),
    ]);
    if (isMonthly) {
      const collected = collectMonthly({
        now, timeZone: env.NOTIFY_TIMEZONE, transactions, categories, budgets,
        premium, seen: state.seen,
      });
      if (collected) {
        report = collected.payload;
        reportStateKey = collected.stateKey;
        if (premium) await addMonthlyInsight(uid, normalizeLanguage(profile.language), collected.payload);
      }
    } else {
      const collected = collectWeekly({ now, timeZone: env.NOTIFY_TIMEZONE, transactions, categories, state });
      if (collected) {
        report = collected.payload;
        reportStateKey = collected.stateKey;
        weeklyEmpty = collected.empty;
        if (premium) await addWeeklyInsight(uid, normalizeLanguage(profile.language), collected.payload);
      }
    }
  }

  if (!lifecycle && events.events.length === 0 && !report) return null;
  const premiumDataUpsell = !premium && events.events.some((event) =>
    event.kind === 'debt' || event.kind === 'deposit' || event.kind === 'goal');
  const stateKeys = [
    ...(lifecycle ? [lifecycle.stateKey] : []),
    ...events.stateKeys,
    ...(reportStateKey ? [reportStateKey] : []),
  ];
  return {
    payload: {
      kind: 'daily', date: now, lifecycle: lifecycle?.payload, events: events.events,
      report, premiumDataUpsell,
    },
    stateKeys,
    stateEffects: {
      trialAvailableSent: lifecycle?.trialAvailableSent || undefined,
      weeklyEmpty: weeklyEmpty === true || undefined,
      weeklyActive: weeklyEmpty === false || undefined,
    },
    blockNames: [lifecycle && 'lifecycle', events.events.length && 'events', report?.kind].filter(Boolean) as string[],
  };
}
