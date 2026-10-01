const DAY_MS = 86_400_000;

export interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

export function calendarParts(timestamp: number, timeZone: string): CalendarParts {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function zonedTimestamp(parts: CalendarParts, timeZone: string): number {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = calendarParts(guess, timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += desired - represented;
  }
  return guess;
}

function shiftedDate(parts: Pick<CalendarParts, 'year' | 'month' | 'day'>, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function dateKey(timestamp: number, timeZone: string): string {
  const { year, month, day } = calendarParts(timestamp, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function dayStart(timestamp: number, timeZone: string): number {
  const parts = calendarParts(timestamp, timeZone);
  return zonedTimestamp({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
}

export function addLocalDays(timestamp: number, days: number, timeZone: string): number {
  const parts = calendarParts(timestamp, timeZone);
  const shifted = shiftedDate(parts, days);
  return zonedTimestamp({ ...shifted, hour: parts.hour, minute: parts.minute, second: parts.second }, timeZone);
}

export function calendarDayDifference(target: number, reference: number, timeZone: string): number {
  const targetParts = calendarParts(target, timeZone);
  const referenceParts = calendarParts(reference, timeZone);
  const targetOrdinal = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day) / DAY_MS;
  const referenceOrdinal = Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day) / DAY_MS;
  return targetOrdinal - referenceOrdinal;
}

export function nextDailySlot(now: number, hour: number, timeZone: string): number {
  const parts = calendarParts(now, timeZone);
  let date = { year: parts.year, month: parts.month, day: parts.day };
  let candidate = zonedTimestamp({ ...date, hour, minute: 0, second: 0 }, timeZone);
  if (candidate <= now) {
    date = shiftedDate(date, 1);
    candidate = zonedTimestamp({ ...date, hour, minute: 0, second: 0 }, timeZone);
  }
  return candidate;
}

export function isQuietHour(now: number, timeZone: string, quietStart: number, quietEnd: number): boolean {
  const hour = calendarParts(now, timeZone).hour;
  return quietStart > quietEnd
    ? hour >= quietStart || hour < quietEnd
    : hour >= quietStart && hour < quietEnd;
}

export function shiftOutOfQuietHours(now: number, timeZone: string, quietStart: number, quietEnd: number): number {
  if (!isQuietHour(now, timeZone, quietStart, quietEnd)) return now;
  const parts = calendarParts(now, timeZone);
  const date = parts.hour >= quietStart ? shiftedDate(parts, 1) : parts;
  return zonedTimestamp({ year: date.year, month: date.month, day: date.day, hour: quietEnd, minute: 0, second: 0 }, timeZone);
}

export function isoWeekKey(timestamp: number, timeZone: string): string {
  const parts = calendarParts(timestamp, timeZone);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function localWeekday(timestamp: number, timeZone: string): number {
  const parts = calendarParts(timestamp, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function localDayRange(timestamp: number, timeZone: string): { start: number; end: number } {
  const start = dayStart(timestamp, timeZone);
  return { start, end: addLocalDays(start, 1, timeZone) };
}

export function previousWeekRange(now: number, timeZone: string): { start: number; end: number } {
  const weekday = localWeekday(now, timeZone) || 7;
  const thisMonday = addLocalDays(dayStart(now, timeZone), 1 - weekday, timeZone);
  return { start: addLocalDays(thisMonday, -7, timeZone), end: thisMonday };
}

export function previousMonthRange(now: number, timeZone: string): { start: number; end: number } {
  const parts = calendarParts(now, timeZone);
  const end = zonedTimestamp({ year: parts.year, month: parts.month, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
  const date = new Date(Date.UTC(parts.year, parts.month - 2, 1));
  const start = zonedTimestamp({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
  return { start, end };
}

export function currentMonthRange(now: number, timeZone: string): { start: number; end: number } {
  const parts = calendarParts(now, timeZone);
  const start = zonedTimestamp({ year: parts.year, month: parts.month, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
  const next = new Date(Date.UTC(parts.year, parts.month, 1));
  const end = zonedTimestamp({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
  return { start, end };
}
