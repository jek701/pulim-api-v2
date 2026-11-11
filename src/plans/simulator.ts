import { z } from 'zod';
import { isoDay, type PlanContext } from './schemas';
export const purchaseSchema = z
  .object({
    amount: z.number().finite().positive(),
    day: isoDay,
    installments: z
      .object({
        months: z.number().int().min(2).max(36),
        monthly: z.number().finite().positive().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type Purchase = z.infer<typeof purchaseSchema>;
export function simulatePurchase(context: PlanContext, purchase: Purchase) {
  const { days } = context;
  const end = days[days.length - 1].d;
  if (purchase.day < days[0].d || purchase.day > end)
    return { error: 'Purchase day is outside the forecast window' };
  const count = purchase.installments?.months ?? 1;
  const monthly = purchase.installments
    ? (purchase.installments.monthly ?? Math.ceil(purchase.amount / count))
    : purchase.amount;
  const [year, month, dom] = purchase.day.split('-').map(Number);
  const payments = Array.from({ length: count }, (_, i) => {
    const m = month - 1 + i;
    const last = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, m, Math.min(dom, last))).toISOString().slice(0, 10);
  }).filter((d) => d <= end);
  const before = {
    low: days.reduce((a, b) => (b.close < a.close ? b : a)),
    firstNegative: days.find((d) => d.close < 0)?.d ?? null,
  };
  const alreadyShort = before.firstNegative !== null;
  const changed = days.map((d) => ({
    d: d.d,
    close: d.close - monthly * payments.filter((p) => p <= d.d).length,
  }));
  const low = changed.reduce((a, b) => (b.close < a.close ? b : a));
  const ok = low.close >= 0;
  let suffixLow = Infinity;
  let earliestOkDay: string | null = null;
  for (let i = days.length - 1; i >= 0; i--) {
    suffixLow = Math.min(suffixLow, days[i].close);
    if (days[i].d >= purchase.day && suffixLow >= purchase.amount) earliestOkDay = days[i].d;
  }
  return {
    ok,
    before,
    alreadyShort,
    low,
    firstNegative: changed.find((d) => d.close < 0)?.d ?? null,
    endClose: changed[changed.length - 1].close,
    windowEnd: end,
    shortBy: ok ? null : -low.close,
    earliestOkDay: alreadyShort ? null : earliestOkDay,
    paymentsInWindow: payments.length,
    paymentsTotal: count,
  };
}
