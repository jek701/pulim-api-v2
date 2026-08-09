import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export interface DateResult {
  date: number;
  ambiguous: boolean;
  reason: 'DATE_IN_FUTURE' | null;
}

export function resolveDate(dateISO: string, now: number, timezoneName = 'Asia/Tashkent'): DateResult {
  if (!dateISO.trim()) return { date: now, ambiguous: false, reason: null };
  const parsed = dayjs(dateISO, 'YYYY-MM-DD', true).tz(timezoneName, true);
  if (!parsed.isValid()) return { date: now, ambiguous: false, reason: null };

  const atNoon = parsed.hour(12).minute(0).second(0).millisecond(0).valueOf();
  const parsedDay = parsed.startOf('day').valueOf();
  const today = dayjs(now).tz(timezoneName).startOf('day').valueOf();
  if (parsedDay > today) return { date: now, ambiguous: true, reason: 'DATE_IN_FUTURE' };
  const oldest = now - 365 * 86_400_000;
  return { date: Math.max(atNoon, oldest), ambiguous: false, reason: null };
}

export function parseUserDate(value: string, now: number, timezoneName = 'Asia/Tashkent'): DateResult {
  const normalized = value.trim().toLocaleLowerCase();
  const today = dayjs(now).tz(timezoneName);
  if (['сегодня', 'bugun', 'today'].includes(normalized)) {
    return resolveDate(today.format('YYYY-MM-DD'), now, timezoneName);
  }
  if (['вчера', 'kecha', 'yesterday'].includes(normalized)) {
    return resolveDate(today.subtract(1, 'day').format('YYYY-MM-DD'), now, timezoneName);
  }
  const formats = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD.MM'];
  for (const format of formats) {
    const parsed = dayjs(normalized, format, true);
    if (!parsed.isValid()) continue;
    const withYear = format === 'DD.MM'
      ? parsed.year(today.year()).format('YYYY-MM-DD')
      : parsed.format('YYYY-MM-DD');
    return resolveDate(withYear, now, timezoneName);
  }
  return { date: Number.NaN, ambiguous: false, reason: null };
}

/** Parse a debt deadline. Unlike a transaction date, a future date is expected. */
export function resolveDueDate(dateISO: string, now: number, timezoneName = 'Asia/Tashkent'): number | null {
  if (!dateISO.trim()) return null;
  const parsed = dayjs(dateISO, 'YYYY-MM-DD', true).tz(timezoneName, true);
  if (!parsed.isValid()) return null;
  return parsed.hour(12).minute(0).second(0).millisecond(0).valueOf();
}
