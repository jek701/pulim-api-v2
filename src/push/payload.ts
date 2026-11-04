import type { SupportedLanguage } from '../telegram/types';
import type { NotificationPayload } from '../notifications/types';
import { formatDate, formatMoney } from '../notifications/format';
import { renderPush } from './templates';
import type { PushPayload } from './types';

export function pushPayload(
  payload: NotificationPayload,
  language: SupportedLanguage,
  timezone: string,
  now: number,
): PushPayload | null {
  if (payload.kind === 'push') {
    const values = { ...payload.values };
    const currency = String(values.currency ?? 'UZS');
    for (const key of ['amount', 'income', 'expense']) {
      if (typeof values[key] === 'number')
        values[key] = formatMoney(values[key] as number, currency, language);
    }
    if (typeof values.date === 'number') values.date = formatDate(values.date, language, timezone);
    return { ...payload, values };
  }
  if (payload.kind === 'budget')
    return {
      kind: 'push',
      type: payload.threshold === 100 ? 'budget_100' : 'budget_80',
      group: 'money',
      entityId: payload.categoryId,
      link: `/budgets/${encodeURIComponent(payload.categoryId)}`,
      eventAt: payload.eventAt ?? now,
      values: {
        category: payload.categoryName,
        percent: Math.floor((payload.spent / payload.budget) * 100),
        amount: formatMoney(
          payload.threshold === 100
            ? payload.spent - payload.budget
            : Math.max(0, payload.budget - payload.spent),
          'UZS',
          language,
        ),
      },
    };
  if (payload.kind === 'campaign')
    return {
      kind: 'push',
      type: 'broadcast',
      group: 'premium',
      link: payload.ctaUrl?.startsWith('/') ? payload.ctaUrl : '/(tabs)',
      entityId: payload.campaignId,
      eventAt: now,
      values: { title: payload.title, body: payload.body },
    };
  return null;
}
export { renderPush };
