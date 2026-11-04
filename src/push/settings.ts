import type { NotificationSettings } from '../domain/types';

export const DEFAULT_PUSH_TIMEZONE = 'Asia/Tashkent';
export const DEFAULT_NOTIFICATION_GROUPS = {
  money: true,
  family: true,
  familyExpenses: false,
  premium: true,
  habit: true,
} as const;

/** Old profiles remain usable before any settings backfill or device migration. */
export function normalizePushSettings(settings?: Partial<NotificationSettings>, timezone?: string) {
  return {
    enabled: settings?.enabled ?? true,
    groups: { ...DEFAULT_NOTIFICATION_GROUPS, ...settings?.groups },
    alsoTelegram: settings?.alsoTelegram ?? false,
    quietHours: { start: '22:00', end: '08:00', ...settings?.quietHours },
    timezone: settings?.timezone ?? timezone ?? DEFAULT_PUSH_TIMEZONE,
  };
}
