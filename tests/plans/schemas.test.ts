import { describe, expect, it } from 'vitest';
import { planContextSchema, planSettingsSchema, planSetupSchema } from '../../src/plans/schemas';
import { chatSchema, settingsPatchSchema } from '../../src/domain/schemas';
import { setup, group, context } from './fixtures';
describe('plan setup validation', () => {
  it('accepts empty and maximum bounded groups', () => {
    expect(planSetupSchema.parse({ ...setup, groups: [] }).groups).toEqual([]);
    expect(
      planSetupSchema.parse({
        ...setup,
        groups: Array.from({ length: 80 }, (_, i) => group(String(i))),
      }).groups,
    ).toHaveLength(80);
  });
  it.each([
    { groups: [group(), group()] },
    { groups: Array.from({ length: 81 }, (_, i) => group(String(i))) },
    { language: 'de' },
    { today: '2026-02-30' },
    { existing: Array(41).fill({ name: 'a', amount: 1, type: 'income' }) },
    ...[
      { id: '' },
      { id: 'x'.repeat(41) },
      { category: 'x'.repeat(61) },
      { names: ['x'.repeat(41)] },
      { names: Array(4).fill('a') },
      { count: 0 },
      { count: 501 },
      { count: 1.5 },
      { medianAmount: Infinity },
      { minAmount: -1 },
      { maxAmount: NaN },
      { currency: 'x'.repeat(9) },
      { dates: Array(13).fill('2026-01-01') },
      { dates: ['2026-02-29'] },
      { cadence: 'daily' },
      { confidence: 'sure' },
    ].map((v) => ({ groups: [group('g', v)] })),
  ])('rejects invalid input %j', (patch) =>
    expect(planSetupSchema.safeParse({ ...setup, ...patch }).success).toBe(false),
  );
});
const settings = {
  everydayEnabled: true,
  everydayManual: null,
  accountOverrides: { a: true },
  updatedAt: 10,
};
describe('forecast settings', () => {
  it('strips unknown keys and permits optional fields', () => {
    expect(settingsPatchSchema.parse({ planSettings: { ...settings, unknown: 1 } })).toEqual({
      planSettings: settings,
    });
    expect(
      planSettingsSchema.parse({ ...settings, headlineDate: 'monthEnd', setupDoneAt: null }),
    ).toMatchObject({ headlineDate: 'monthEnd' });
  });
  it.each([
    { everydayManual: -1 },
    { everydayManual: Infinity },
    { updatedAt: NaN },
    { accountOverrides: { ['x'.repeat(65)]: true } },
    { accountOverrides: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i, true])) },
    { headlineDate: '2026-02-30' },
    { headlineMode: 'bad' },
    { forecastPush: 1 },
  ])('rejects %j', (patch) =>
    expect(planSettingsSchema.safeParse({ ...settings, ...patch }).success).toBe(false),
  );
});
describe('request-local plan context', () => {
  it('accepts context through chat schema', () =>
    expect(chatSchema.parse({ message: 'Can I?', planContext: context() }).planContext).toEqual(
      context(),
    ));
  it.each([
    { days: [] },
    { days: Array(121).fill({ d: '2026-01-30', close: 1 }) },
    { days: [{ d: '2026-01-31', close: 1 }] },
    {
      days: [
        { d: '2026-01-30', close: 1 },
        { d: '2026-02-01', close: 2 },
      ],
    },
    { items: Array(81).fill({ d: '2026-01-30', name: 'a', amount: 1 }) },
    { items: [{ d: '2026-01-30', name: 'x'.repeat(41), amount: 1 }] },
    { balance: Infinity },
    { pendingIncomes: -1 },
    { pendingIncomes: 1.2 },
    { everydayPerDay: -1 },
    { currency: 'x'.repeat(9) },
    { nextIncome: { d: '2026-02-30', amount: 1, name: 'a' } },
    { extra: 1 },
  ])('rejects invalid %j', (patch) =>
    expect(planContextSchema.safeParse({ ...context(), ...patch }).success).toBe(false),
  );
});

import { planSetupCases } from '../fixtures/planSetupCases';
it('ships at least twelve bounded synthetic setup eval cases without calling a model', () => {
  expect(planSetupCases.length).toBeGreaterThanOrEqual(12);
  for (const c of planSetupCases) expect(planSetupSchema.safeParse(c.input).success).toBe(true);
});
