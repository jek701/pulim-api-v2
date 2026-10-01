import { env } from '../../config/env';
import type { SupportedLanguage } from '../../telegram/types';
import { notificationStrings } from '../i18n';
import type { DailyPayload, NotificationPayload, RenderedNotification } from '../types';

type Item = RenderedNotification['items'][number];
type Button = RenderedNotification['keyboard']['inline_keyboard'][number][number];

function webAppUrl(params: Record<string, string> = {}): string {
  const url = new URL(env.WEB_APP_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function dailyActions(payload: DailyPayload, language: SupportedLanguage, completedActions: number[]): { rows: Button[][]; items: Item[] } {
  const rows: Button[][] = [];
  const items: Item[] = [];
  const actionButtons: Button[] = [];
  for (const event of payload.events.slice(0, 8)) {
    if (actionButtons.length >= 6) break;
    if (event.kind === 'subscription') {
      const index = items.length;
      items.push({
        draftId: null, transactionId: null, subscriptionId: event.id,
        expectedNextBillingDate: event.nextBillingDate,
      });
      if (!completedActions.includes(index)) actionButtons.push({
        text: language === 'uz' ? `💳 ${event.name} to‘lash` : language === 'en' ? `💳 Pay ${event.name}` : `💳 Оплатить ${event.name}`,
        callback_data: `v1:paysub:${index}`,
      });
    } else if (event.kind === 'debt') {
      const index = items.length;
      items.push({ draftId: null, transactionId: null, debtId: event.id });
      if (!completedActions.includes(index)) actionButtons.push({
        text: language === 'uz' ? '💰 Qarzni yopish' : language === 'en' ? '💰 Settle debt' : '💰 Погасить долг',
        callback_data: `v1:paydebt:${index}`,
      });
    }
  }
  for (let index = 0; index < actionButtons.length; index += 2) rows.push(actionButtons.slice(index, index + 2));
  const needsPremium = payload.premiumDataUpsell
    || payload.report?.kind === 'monthly' && payload.report.premiumUpsell
    || payload.lifecycle?.kind === 'trial_ending_1d'
    || payload.lifecycle?.kind === 'trial_ending_3d'
    || payload.lifecycle?.kind === 'premium_expired'
    || payload.lifecycle?.kind === 'trial_available';
  if (needsPremium) rows.push([{ text: notificationStrings.premium(), web_app: { url: env.PREMIUM_CHECKOUT_URL || webAppUrl({ upgrade: '1' }) } }]);
  rows.push([
    { text: notificationStrings.open(language), web_app: { url: env.WEB_APP_URL } },
    { text: notificationStrings.disable(language), callback_data: 'v1:notifyoff:0' },
  ]);
  return { rows, items };
}

export function renderKeyboard(payload: NotificationPayload, language: SupportedLanguage, completedActions: number[] = []) {
  if (payload.kind === 'daily') {
    const result = dailyActions(payload, language, completedActions);
    return { keyboard: { inline_keyboard: result.rows }, items: result.items };
  }
  return {
    keyboard: { inline_keyboard: [[
      { text: notificationStrings.open(language), web_app: { url: env.WEB_APP_URL } },
      { text: notificationStrings.disable(language), callback_data: 'v1:notifyoff:0' },
    ]] },
    items: [] as Item[],
  };
}
