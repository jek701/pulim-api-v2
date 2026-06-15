import type { BillingCycle } from './types';

/** Advance a billing timestamp by one cycle. Ported from `advanceBillingDate`. */
export function advanceBillingDate(ts: number, cycle: BillingCycle): number {
  const d = new Date(ts);
  if (cycle === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setDate(d.getDate() + 7); // weekly
  return d.getTime();
}
