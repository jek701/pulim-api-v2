/** Tashkent is UTC+5 without DST (same boundary as capture/time.ts). */
export const DAY = 86_400_000;
export const OFFSET = 5 * 3_600_000;
export const TIMEZONE = 'Asia/Tashkent';
export const dayKey = (ms: number): string => new Date(ms + OFFSET).toISOString().slice(0, 10);
export const dateTime = (ms: number): string =>
  new Date(ms + OFFSET).toISOString().slice(0, 16).replace('T', ' ');
export function dayMs(key: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Expected YYYY-MM-DD');
  const ms = Date.parse(`${key}T00:00:00+05:00`);
  if (!Number.isFinite(ms) || dayKey(ms) !== key) throw new Error('Invalid calendar date');
  return ms;
}
export const weekday = (ms: number): number => new Date(ms + OFFSET).getUTCDay() || 7;
export const hour = (ms: number): number => new Date(ms + OFFSET).getUTCHours();
export const monthKey = (ms: number): string => dayKey(ms).slice(0, 7);
export function weekKey(ms: number): string {
  const d = new Date(dayMs(dayKey(ms)) + OFFSET);
  d.setUTCDate(d.getUTCDate() + 4 - weekday(ms));
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
export function days(from: string, to: string): string[] {
  const start = dayMs(from),
    end = dayMs(to);
  if (end < start || end - start > 1100 * DAY)
    throw new Error('Invalid date range (maximum 3 years)');
  return Array.from({ length: Math.floor((end - start) / DAY) + 1 }, (_, i) =>
    dayKey(start + i * DAY),
  );
}
export const matchingDays = (from: string, to: string, weekdays: number[] | null): number =>
  days(from, to).filter((d) => !weekdays || weekdays.includes(weekday(dayMs(d)))).length;
export function earliestDay(now = Date.now()): string {
  const d = new Date(now + OFFSET);
  const year = d.getUTCFullYear() - 3,
    month = d.getUTCMonth();
  const dom = Math.min(d.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return dayKey(Date.UTC(year, month, dom) - OFFSET);
}
export function validateRange(from: string, to: string, now = Date.now()): void {
  days(from, to);
  if (from < earliestDay(now)) throw new Error(`Earliest allowed date is ${earliestDay(now)}`);
  const anniversary = new Date(dayMs(from) + OFFSET);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 3);
  if (dayMs(to) + OFFSET > anniversary.getTime()) throw new Error('Maximum range is 3 years');
}
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const start = new Date(dayMs(from) + OFFSET);
  return {
    from,
    to: dayKey(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - OFFSET - DAY),
  };
}
