import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import type { Currency } from '../domain/types';
import { db } from '../config/firebase';
import { env } from '../config/env';
import { logger } from '../utils/logger';

dayjs.extend(utc);
dayjs.extend(timezone);

interface CacheEntry { rates: Record<string, number>; fetchedAt: number }
interface NbuEntry { Ccy: string; Nominal: string; Rate: string }
const memory = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<Record<string, number> | null>>();

const dateKey = (dateMs: number) => dayjs(dateMs).tz(env.TELEGRAM_DEFAULT_TIMEZONE).format('YYYY-MM-DD');
const todayKey = () => dateKey(Date.now());
const isFresh = (key: string, fetchedAt: number) => key !== todayKey() || Date.now() - fetchedAt < 6 * 60 * 60_000;

async function fetchRates(key: string): Promise<Record<string, number> | null> {
  const url = key === todayKey()
    ? 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/'
    : `https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/${key}/`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`NBU returned ${response.status}`);
    const data = await response.json() as NbuEntry[];
    const rates: Record<string, number> = { UZS: 1 };
    for (const entry of data) {
      const rate = Number.parseFloat(entry.Rate);
      const nominal = Number.parseFloat(entry.Nominal) || 1;
      if (Number.isFinite(rate) && rate > 0) rates[entry.Ccy] = rate / nominal;
    }
    const fetchedAt = Date.now();
    memory.set(key, { rates, fetchedAt });
    await db.collection('fxRates').doc(key).set({ rates, fetchedAt }, { merge: true });
    return rates;
  } catch (error) {
    logger.warn({ err: error, date: key }, 'fx.rates.unavailable');
    return null;
  }
}

async function ratesFor(dateMs: number): Promise<Record<string, number> | null> {
  const key = dateKey(dateMs);
  const cached = memory.get(key);
  if (cached && isFresh(key, cached.fetchedAt)) return cached.rates;
  const stored = await db.collection('fxRates').doc(key).get();
  if (stored.exists) {
    const value = stored.data() as CacheEntry;
    if (value.rates && isFresh(key, value.fetchedAt)) {
      memory.set(key, value);
      return value.rates;
    }
  }
  if (!pending.has(key)) {
    pending.set(key, fetchRates(key).finally(() => pending.delete(key)));
  }
  return pending.get(key)!;
}

export async function getRateToBase(currency: Currency, dateMs: number): Promise<number | null> {
  if (currency === 'UZS') return 1;
  const rates = await ratesFor(dateMs);
  return rates?.[currency] ?? null;
}

