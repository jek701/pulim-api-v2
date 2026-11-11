import { z } from 'zod';
const number = z.number().finite();
export const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const ms = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
  }, 'Invalid calendar date');
const kind = z.enum(['income', 'expense']);
const confidence = z.enum(['high', 'medium', 'low']);
export const planSetupSchema = z.object({
  language: z.enum(['uz', 'ru', 'en']),
  today: isoDay,
  groups: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        type: kind,
        category: z.string().max(60),
        names: z.array(z.string().max(40)).max(3),
        count: number.int().min(1).max(500),
        medianAmount: number.nonnegative(),
        minAmount: number.nonnegative(),
        maxAmount: number.nonnegative(),
        currency: z.string().max(8),
        dates: z.array(isoDay).max(12),
        cadence: z.enum(['weekly', 'biweekly', 'monthly']).nullable(),
        confidence: confidence.nullable(),
      }),
    )
    .max(80)
    .refine((gs) => new Set(gs.map((g) => g.id)).size === gs.length, 'Duplicate group id'),
  existing: z
    .array(z.object({ name: z.string().max(40), amount: number.nonnegative(), type: kind }))
    .max(40),
});
export type PlanSetup = z.infer<typeof planSetupSchema>;
export const setupItemSchema = z.object({
  groupIds: z.array(z.string()),
  role: z.enum(['income', 'payment', 'everyday', 'ignore']),
  label: z.string(),
  confidence,
});
export type SetupItem = z.infer<typeof setupItemSchema>;
export const planSettingsSchema = z
  .object({
    everydayEnabled: z.boolean(),
    everydayManual: number.nonnegative().nullable(),
    accountOverrides: z
      .record(z.string().max(64), z.boolean())
      .refine((v) => Object.keys(v).length <= 100, 'Too many accounts'),
    headlineMode: z.enum(['date', 'payday', 'perDay']).optional(),
    headlineDate: z.union([z.literal('monthEnd'), isoDay]).optional(),
    setupDoneAt: number.nullable().optional(),
    tipsDoneAt: number.nullable().optional(),
    forecastPush: z.boolean().optional(),
    updatedAt: number,
  })
  .strip();
export type PlanSettings = z.infer<typeof planSettingsSchema>;
export const planContextSchema = z
  .object({
    today: isoDay,
    currency: z.string().min(1).max(8),
    balance: number,
    everydayPerDay: number.nonnegative(),
    headline: z
      .object({ mode: z.enum(['date', 'payday', 'perDay']), day: isoDay, value: number })
      .strict(),
    days: z
      .array(z.object({ d: isoDay, close: number }).strict())
      .min(1)
      .max(120),
    items: z
      .array(z.object({ d: isoDay, name: z.string().max(40), amount: number }).strict())
      .max(80),
    nextIncome: z
      .object({ d: isoDay, amount: number.nonnegative(), name: z.string().max(40) })
      .strict()
      .nullable(),
    pendingIncomes: number.int().nonnegative(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const start = Date.parse(`${v.today}T00:00:00Z`);
    if (v.days.some((d, i) => Date.parse(`${d.d}T00:00:00Z`) !== start + i * 86400000))
      ctx.addIssue({
        code: 'custom',
        path: ['days'],
        message: 'Days must be consecutive and start at today',
      });
  });
export type PlanContext = z.infer<typeof planContextSchema>;
