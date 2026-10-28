/** Day keys ('YYYY-MM-DD', the user's local calendar day) of a planned expense's `paid` / `skipped`. */
export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const PLAN_KEY_RETENTION_DAYS = 60;
export const MAX_SKIPPED_DAYS = 400;

/** Oldest day key still kept: `now` minus 60 days, as a UTC date string (day keys sort lexicographically). */
export function planKeyCutoff(now: number): string {
  return new Date(now - PLAN_KEY_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** Drop `paid` entries and `skipped` days older than the retention window. */
export function prunePlanDayKeys(
  paid: Record<string, string> | undefined,
  skipped: string[] | undefined,
  now: number,
): { paid: Record<string, string>; skipped?: string[] } {
  const cutoff = planKeyCutoff(now);
  const keptPaid = Object.fromEntries(Object.entries(paid ?? {}).filter(([day]) => day >= cutoff));
  return {
    paid: keptPaid,
    ...(skipped ? { skipped: skipped.filter((day) => day >= cutoff) } : {}),
  };
}
