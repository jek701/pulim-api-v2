import { z } from 'zod';

export const captureTimezone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; }
  catch { return false; }
});
export function captureMonth(now = new Date()): { month: string; resetsAt: string } {
  // Uzbekistan has no daylight-saving changes; boundaries are always UTC+05:00.
  const local = new Date(now.getTime() + 5 * 3600_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    month: `${year}-${String(month + 1).padStart(2, '0')}`,
    resetsAt: new Date(Date.UTC(year, month + 1, 1) - 5 * 3600_000).toISOString(),
  };
}

export function dateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const get = (key: string) => parts.find(part => part.type === key)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}
