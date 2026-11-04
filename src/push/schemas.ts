import { z } from 'zod';

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA timezone.');
export const languageSchema = z.enum(['uz', 'ru', 'en']);
// APNs tokens are variable length; normalize hex so casing cannot create duplicate devices.
export const deviceTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^(?:[0-9a-fA-F]{2})+$/)
  .transform((value) => value.toLowerCase());
export const registerDeviceSchema = z
  .object({
    token: deviceTokenSchema,
    platform: z.literal('ios'),
    environment: z.enum(['sandbox', 'production']),
    bundleId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
    appVersion: z.string().trim().min(1).max(64),
    buildNumber: z.string().trim().min(1).max(64),
    language: languageSchema,
    timezone: timezoneSchema,
  })
  .strip();
export type DeviceRegistration = z.infer<typeof registerDeviceSchema>;
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const pushSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    groups: z
      .object({
        money: z.boolean().optional(),
        family: z.boolean().optional(),
        familyExpenses: z.boolean().optional(),
        premium: z.boolean().optional(),
        habit: z.boolean().optional(),
      })
      .strip()
      .optional(),
    alsoTelegram: z.boolean().optional(),
    quietHours: z.object({ start: time.optional(), end: time.optional() }).strip().optional(),
    timezone: timezoneSchema.optional(),
  })
  .strip()
  .refine((value) => Object.keys(value).length > 0, 'Supply a notification setting.');
export type NotificationSettingsPatch = z.infer<typeof pushSettingsPatchSchema>;
