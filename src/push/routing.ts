import type { NotificationSettings } from '../domain/types';
import { addLocalDays, calendarParts, zonedTimestamp } from '../notifications/schedule';
import type { PushGroup } from './types';

export function notificationChannels(input: {
  settings?: NotificationSettings;
  activeDevice: boolean;
  configured: boolean;
  group?: PushGroup;
  digest?: boolean;
  pushOnly?: boolean;
  marketing?: { inApp: boolean; telegram: boolean };
}): { push: boolean; telegram: boolean } {
  const settings = input.settings;
  if (!input.marketing && !settings?.enabled) return { push: false, telegram: false };
  const active =
    input.activeDevice && input.configured && !input.digest && input.marketing?.inApp !== false;
  const groupEnabled =
    !input.group || (settings?.groups?.[input.group] ?? input.group !== 'familyExpenses');
  const telegramReachable = Boolean(
    settings?.telegram?.chatId &&
    settings?.telegram?.status !== 'blocked' &&
    settings?.telegram?.status !== 'unreachable',
  );
  if (!input.marketing && !groupEnabled && (active || input.group === 'familyExpenses'))
    return { push: false, telegram: false };
  return {
    push: active,
    telegram:
      telegramReachable &&
      !input.pushOnly &&
      input.marketing?.telegram !== false &&
      (!active || settings?.alsoTelegram === true),
  };
}

/** Minute precision, including overnight windows and DST transitions. Equal ends disable quiet hours. */
export function quietHoursUntil(
  now: number,
  timeZone: string,
  quiet: { start: string; end: string },
): number | null {
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minute(quiet.start);
  const end = minute(quiet.end);
  const parts = calendarParts(now, timeZone);
  const current = parts.hour * 60 + parts.minute;
  const inside =
    start > end ? current >= start || current < end : current >= start && current < end;
  if (!inside) return null;
  const date =
    start > end && current >= start
      ? calendarParts(addLocalDays(now, 1, timeZone), timeZone)
      : parts;
  const candidate = zonedTimestamp(
    { ...date, hour: Math.floor(end / 60), minute: end % 60, second: 0 },
    timeZone,
  );
  if (candidate > now) return candidate;
  // During the repeated DST hour, the first matching wall time may already have passed.
  for (
    let next = Math.floor(now / 60000) * 60000 + 60000;
    next < now + 48 * 3600000;
    next += 60000
  ) {
    const local = calendarParts(next, timeZone);
    const value = local.hour * 60 + local.minute;
    const stillQuiet = start > end ? value >= start || value < end : value >= start && value < end;
    if (!stillQuiet) return next;
  }
  return null;
}
