import { describe, it, expect } from 'vitest';
import { simulatePurchase } from '../../src/plans/simulator';
import { getPlanForecast, executePlanTool, planSummary } from '../../src/plans/tools';
import { context } from './fixtures';
describe('pure purchase simulation', () => {
  it('pays once and does not mutate the forecast', () => {
    const p = context();
    const before = structuredClone(p);
    expect(simulatePurchase(p, { amount: 50, day: p.today })).toMatchObject({
      ok: true,
      before: { low: { d: '2026-01-31', close: 80 }, firstNegative: null },
      alreadyShort: false,
      low: { d: '2026-01-31', close: 30 },
      firstNegative: null,
      endClose: 100,
      shortBy: null,
      paymentsInWindow: 1,
      paymentsTotal: 1,
      earliestOkDay: p.today,
      windowEnd: '2026-02-01',
    });
    expect(p).toEqual(before);
  });
  it('reports deficit and earliest affordable day', () =>
    expect(simulatePurchase(context(), { amount: 90, day: '2026-01-30' })).toMatchObject({
      ok: false,
      shortBy: 10,
      firstNegative: '2026-01-31',
      earliestOkDay: '2026-02-01',
    }));
  it('reports a pre-existing deficit and does not suggest a purchase day', () => {
    const p = context([100, -10, 150]);
    expect(simulatePurchase(p, { amount: 20, day: '2026-02-01' })).toMatchObject({
      before: { low: { d: '2026-01-31', close: -10 }, firstNegative: '2026-01-31' },
      alreadyShort: true,
      earliestOkDay: null,
    });
  });
  it('returns null when no day works', () =>
    expect(simulatePurchase(context(), { amount: 200, day: '2026-01-30' })).toMatchObject({
      earliestOkDay: null,
    }));
  it('subtracts only on and after the purchase', () =>
    expect(simulatePurchase(context(), { amount: 90, day: '2026-02-01' })).toMatchObject({
      ok: true,
      endClose: 60,
      low: { d: '2026-02-01', close: 60 },
    }));
  it('clamps installments to month length while preserving the original anchor', () => {
    const p = context(Array(65).fill(1000));
    const result = simulatePurchase(p, {
      amount: 300,
      day: '2026-01-31',
      installments: { months: 3 },
    });
    expect(result).toMatchObject({ paymentsInWindow: 3, paymentsTotal: 3, endClose: 700 });
    const short = { ...p, days: p.days.filter((d) => d.d <= '2026-03-30') };
    expect(
      simulatePurchase(short, { amount: 301, day: '2026-01-31', installments: { months: 3 } }),
    ).toMatchObject({ paymentsInWindow: 2, endClose: 798 });
    expect(
      simulatePurchase(p, {
        amount: 300,
        day: '2026-01-31',
        installments: { months: 3, monthly: 120 },
      }),
    ).toMatchObject({ endClose: 640 });
  });
  it('counts payments beyond the window separately', () =>
    expect(
      simulatePurchase(context(), { amount: 300, day: '2026-01-30', installments: { months: 36 } }),
    ).toMatchObject({ paymentsInWindow: 1, paymentsTotal: 36, endClose: 141 }));
  it.each(['2026-01-29', '2026-02-02'])('rejects outside window %s', (day) =>
    expect(simulatePurchase(context(), { amount: 10, day })).toHaveProperty('error'),
  );
  it('validates model arguments', () => {
    expect(
      executePlanTool('simulate_purchase', { amount: 0, day: '2026-01-30' }, context()),
    ).toHaveProperty('error');
    expect(
      executePlanTool('get_plan_forecast', { from: '2026-02-01', to: '2026-01-01' }, context()),
    ).toHaveProperty('error');
  });
});
describe('forecast read tool', () => {
  it('filters ranges', () =>
    expect(getPlanForecast(context(), '2026-01-31', '2026-01-31')).toEqual({
      days: [{ d: '2026-01-31', close: 80 }],
      items: [],
    }));
  it('keeps endpoints, lowest and event days in <=40 samples', () => {
    const p = context(Array.from({ length: 120 }, (_, i) => (i === 57 ? -1 : 100)));
    p.items = [{ d: p.days[89].d, name: 'Rent', amount: -1 }];
    const r = getPlanForecast(p);
    expect(r.days).toHaveLength(40);
    expect(r.days).toEqual(
      expect.arrayContaining([p.days[0], p.days[119], p.days[57], p.days[89]]),
    );
  });
  it('prioritizes essential points when there are 50 item days', () => {
    const p = context(Array.from({ length: 80 }, (_, i) => (i === 60 ? -20 : i === 55 ? -1 : 100)));
    p.items = p.days.slice(0, 50).map((d) => ({ d: d.d, name: 'a', amount: 1 }));
    const r = getPlanForecast(p);
    expect(r.days).toHaveLength(40);
    expect(r.days).toEqual(expect.arrayContaining([p.days[0], p.days[79], p.days[60], p.days[55]]));
    expect(r.items).toHaveLength(50);
  });
  it('summarizes pending incomes and nearest items', () => {
    const p = context();
    p.pendingIncomes = 2;
    expect(planSummary(p)).toContain('Incomes awaiting confirmation are not counted');
    expect(planSummary(p)).toContain('"pendingIncomes":2');
  });
});

import { planToolDefinitions } from '../../src/plans/tools';
it('exports strict nullable optional tool arguments with valid JSON schema types', () => {
  for (const tool of planToolDefinitions) {
    expect(tool.strict).toBe(true);
    expect(tool.parameters?.additionalProperties).toBe(false);
    const walk = (schema: any) => {
      if (Array.isArray(schema.type))
        expect(schema.type.every((t: unknown) => typeof t === 'string')).toBe(true);
      for (const child of Object.values(schema.properties ?? {})) walk(child);
    };
    walk(tool.parameters);
  }
});
