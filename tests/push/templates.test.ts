import { describe, expect, it } from 'vitest';
import { pushTemplates, renderPush, truncatePushText } from '../../src/push/templates';
import { PUSH_TYPES, type PushPayload } from '../../src/push/types';

const values = {
  category: 'Еда', percent: 80, amount: '1 250 000 сум', name: 'Netflix', account: 'Visa',
  person: 'Али', date: '7 ноября', days: 3, income: '5 000 000 сум', expense: '1 250 000 сум',
  month: 'октября', change: 'На 12% меньше, чем неделю назад', title: 'Новость', body: 'Текст новости',
};
const payload: PushPayload = { kind: 'push', type: 'budget_80', group: 'money', entityId: 'cat1',
  link: '/budgets/cat1', values, eventAt: 1 };

describe('push templates', () => {
  it.each(['uz', 'ru', 'en'] as const)('has all 21 templates in %s with bounded plain text', language => {
    expect(Object.keys(pushTemplates[language]).sort()).toEqual([...PUSH_TYPES].sort());
    for (const type of PUSH_TYPES) {
      const result = renderPush({ ...payload, type }, language, 'n1');
      expect(result.aps.alert.title).not.toMatch(/\{\w+\}/);
      expect(result.aps.alert.body).not.toMatch(/\{\w+\}/);
      expect(result.aps.alert.title.length).toBeGreaterThan(0);
      expect(result.aps.alert.body.length).toBeGreaterThan(0);
      expect(Array.from(result.aps.alert.title).length).toBeLessThanOrEqual(50);
      expect(Array.from(result.aps.alert.body).length).toBeLessThanOrEqual(150);
    }
  });

  it('preserves the approved Russian budget text and formatted amount verbatim', () => {
    expect(renderPush(payload, 'ru', 'n1').aps.alert).toEqual({
      title: 'Бюджет «Еда» почти исчерпан',
      body: 'Потрачено 80% — осталось 1 250 000 сум до конца месяца',
    });
  });

  it('has time-sensitive interruption only for exceeded budgets and Apple billing failure', () => {
    for (const type of PUSH_TYPES) {
      expect(renderPush({ ...payload, type }, 'ru', 'n1').aps['interruption-level'])
        .toBe(type === 'budget_100' || type === 'apple_billing_failed' ? 'time-sensitive' : 'active');
    }
  });

  it('assigns action categories and preserves the routing contract', () => {
    for (const type of ['subscription_due', 'debt_due', 'evening_log'] as const) {
      const result = renderPush({ ...payload, type }, 'ru', 'n1');
      expect(result.aps.category).toBe({ subscription_due: 'SUBSCRIPTION_DUE', debt_due: 'DEBT_DUE', evening_log: 'EVENING_LOG' }[type]);
      expect(result).toMatchObject({ type, entityId: 'cat1', link: '/budgets/cat1', notificationId: 'n1' });
    }
    expect(renderPush(payload, 'uz', 'n1').aps).not.toHaveProperty('category');
    expect(renderPush({ ...payload, entityId: undefined }, 'uz', 'n1')).not.toHaveProperty('entityId');
  });

  it.each(['uz', 'ru', 'en'] as const)('localizes both trial horizons in %s', language => {
    const one = renderPush({ ...payload, type: 'trial_ending', values: { days: 1 } }, language, 'n').aps.alert.title;
    const three = renderPush({ ...payload, type: 'trial_ending', values: { days: 3 } }, language, 'n').aps.alert.title;
    expect(one).toContain({ ru: 'завтра', uz: 'ertaga', en: 'tomorrow' }[language]);
    expect(three).toContain('3');
  });

  it('truncates names and broadcasts at grapheme boundaries', () => {
    const name = '👩🏽‍💻'.repeat(90);
    const result = renderPush({ ...payload, type: 'broadcast', values: { title: name, body: 'x'.repeat(200) } }, 'en', 'n');
    expect(Array.from(result.aps.alert.title).length).toBeLessThanOrEqual(50);
    expect(result.aps.alert.title).toMatch(/^(👩🏽‍💻)*…$/u);
    expect(result.aps.alert.body).toBe(`${'x'.repeat(149)}…`);
    expect(truncatePushText('a\u0301'.repeat(30), 50)).toMatch(/^(a\u0301)*…$/u);
  });
});
