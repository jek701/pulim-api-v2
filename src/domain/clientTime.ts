/** Offline clients stamp the moment the user acted; the server only accepts a plausible one. */
export const CLIENT_DATE_MAX_PAST_MS = 90 * 86_400_000;
export const CLIENT_DATE_MAX_FUTURE_MS = 5 * 60_000;
/**
 * The operation time: the client's `date` (epoch ms) when it lies within
 * [now - 90 days, now + 5 minutes], otherwise (absent, bad clock) the server's now.
 */
export function clientNow(date: unknown, now = Date.now()): number {
  if (
    typeof date === 'number' &&
    Number.isFinite(date) &&
    date >= now - CLIENT_DATE_MAX_PAST_MS &&
    date <= now + CLIENT_DATE_MAX_FUTURE_MS
  )
    return Math.round(date);
  return now;
}
