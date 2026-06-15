import type { PlannedExpense } from './types';

// Ported verbatim from the frontend `src/utils/recurrence.ts`.
export function plannedAppliesToDay(pe: PlannedExpense, date: Date): boolean {
  const dow = date.getDay();
  const dom = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth(), dom).getTime();
  if (pe.endDate && target > new Date(pe.endDate).setHours(0, 0, 0, 0)) return false;
  const anchor = pe.date ? new Date(pe.date) : null;
  if (anchor) anchor.setHours(0, 0, 0, 0);
  if (anchor && target < anchor.getTime() && pe.recurrence !== 'once') return false;
  switch (pe.recurrence) {
    case 'once': {
      if (!pe.date) return false;
      const d = new Date(pe.date);
      return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === dom;
    }
    case 'daily':
      return true;
    case 'monthly':
      return pe.dayOfMonth === dom;
    case 'weekly':
      return pe.dayOfWeek?.includes(dow) ?? false;
    case 'weekends':
      return dow === 0 || dow === 6;
    case 'weekdays':
      return dow >= 1 && dow <= 5;
    case 'yearly': {
      if (!anchor) return false;
      return anchor.getMonth() === date.getMonth() && anchor.getDate() === dom;
    }
    case 'custom': {
      if (!anchor || !pe.customInterval || pe.customInterval < 1 || !pe.customUnit) return false;
      const n = pe.customInterval;
      if (pe.customUnit === 'day') {
        const diffDays = Math.round((target - anchor.getTime()) / 86400000);
        return diffDays >= 0 && diffDays % n === 0;
      }
      if (pe.customUnit === 'week') {
        const diffDays = Math.round((target - anchor.getTime()) / 86400000);
        const weeksMatch = diffDays >= 0 && Math.floor(diffDays / 7) % n === 0;
        if (!weeksMatch) return false;
        const days = pe.dayOfWeek && pe.dayOfWeek.length > 0 ? pe.dayOfWeek : [anchor.getDay()];
        return days.includes(dow);
      }
      if (pe.customUnit === 'month') {
        const monthsDiff =
          (date.getFullYear() - anchor.getFullYear()) * 12 + (date.getMonth() - anchor.getMonth());
        if (monthsDiff < 0 || monthsDiff % n !== 0) return false;
        const targetDom = pe.dayOfMonth ?? anchor.getDate();
        return dom === targetDom;
      }
      if (pe.customUnit === 'year') {
        const yearsDiff = date.getFullYear() - anchor.getFullYear();
        if (yearsDiff < 0 || yearsDiff % n !== 0) return false;
        return date.getMonth() === anchor.getMonth() && dom === anchor.getDate();
      }
      return false;
    }
  }
}
