import 'dotenv/config';
import { z } from 'zod';

/** Parses "true"/"false" strings (anything else => false). */
const boolish = z
  .string()
  .optional()
  .transform((v) => (v ?? '').toLowerCase() === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  /** Comma-separated allowlist; empty string => allow all origins (dev). */
  CORS_ORIGINS: z.string().default(''),

  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  FIRESTORE_DATABASE_ID: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  TELEGRAM_BOT_USERNAME: z.string().default(''),
  DEBUG_TELEGRAM_AUTH: boolish,

  TELEGRAM_QUICK_ENTRY_ENABLED: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  TELEGRAM_WEBHOOK_URL: z.string().default(''),
  TELEGRAM_DEFAULT_TIMEZONE: z.string().default('Asia/Tashkent'),
  TELEGRAM_PARSE_MODEL: z.string().default('gpt-5.4-mini'),
  TELEGRAM_PARSE_MODEL_ESCALATION: z.string().default('gpt-5.6-terra'),
  TELEGRAM_PARSE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(10_000).default(2_500),
  TELEGRAM_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(20_000),
  TELEGRAM_PARSE_DAILY_LIMIT: z.coerce.number().int().positive().default(100),
  TELEGRAM_PARSE_PER_MINUTE_LIMIT: z.coerce.number().int().positive().default(10),
  TELEGRAM_DRAFT_TTL_HOURS: z.coerce.number().positive().default(24),
  TELEGRAM_MAX_ITEMS_PER_MESSAGE: z.coerce.number().int().positive().max(25).default(10),
  TELEGRAM_MAX_MESSAGE_CHARS: z.coerce.number().int().positive().max(4_000).default(1_000),
  TELEGRAM_FX_RETRY_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  TELEGRAM_FX_RETRY_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(20),
  TELEGRAM_FX_MAX_RETRY_HOURS: z.coerce.number().positive().default(168),
  WEB_APP_URL: z.string().default(''),
  PREMIUM_CHECKOUT_URL: z.string().default(''),

  OPENAI_API_KEY: z.string().optional(),
  AI_MODEL_FREE: z.string().default('gpt-5.4-mini'),
  AI_MODEL_PREMIUM: z.string().default('gpt-5.6-terra'),
  AI_MODEL_FORECAST: z.string().default('gpt-5.4-mini'),

  AI_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  AI_MAX_HISTORY_MESSAGES: z.coerce.number().int().positive().max(40).default(12),
  AI_MAX_OUTPUT_TOKENS_FREE: z.coerce.number().int().positive().max(25_000).default(1_600),
  AI_MAX_OUTPUT_TOKENS_PREMIUM: z.coerce.number().int().positive().max(25_000).default(6_000),
  AI_MAX_OUTPUT_TOKENS_FORECAST: z.coerce.number().int().positive().max(25_000).default(3_000),
  AI_PREMIUM_MESSAGES_PER_PERIOD: z.coerce.number().int().positive().default(500),

  PULIM_PAYMENT_INTERNAL_SECRET: z.string().min(32).optional(),

  // ── Eskiz SMS gateway (phone sign-in) ──────────────────────────────────────
  ESKIZ_BASE_URL: z.string().default('https://notify.eskiz.uz'),
  ESKIZ_EMAIL: z.string().default(''),
  ESKIZ_PASSWORD: z.string().default(''),
  /** Sender id. `4546` is Eskiz's shared test sender; replace with your nickname once approved. */
  ESKIZ_FROM: z.string().default('4546'),
  /** Optional delivery-status webhook passed to Eskiz as `callback_url`. */
  ESKIZ_CALLBACK_URL: z.string().default(''),
  ESKIZ_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(15_000),

  /** Optional HMAC key for stored code hashes; defaults to a project-id-derived key. */
  PHONE_CODE_PEPPER: z.string().default(''),
  PHONE_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
  PHONE_CODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  PHONE_CODE_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  PHONE_CODE_MAX_SENDS_PER_HOUR: z.coerce.number().int().min(1).max(50).default(5),
  /** Dev-only escape hatch: returns the code in the API response instead of requiring a real SMS. */
  PHONE_AUTH_DEBUG_ECHO_CODE: boolish,
}).superRefine((value, context) => {
  if (value.PHONE_AUTH_DEBUG_ECHO_CODE && value.NODE_ENV === 'production') {
    context.addIssue({
      code: 'custom',
      path: ['PHONE_AUTH_DEBUG_ECHO_CODE'],
      message: 'Must be false in production — it would leak SMS codes over the API.',
    });
  }
  if (!value.TELEGRAM_QUICK_ENTRY_ENABLED) return;
  try {
    const webhookUrl = new URL(value.TELEGRAM_WEBHOOK_URL);
    if (webhookUrl.protocol !== 'https:' || webhookUrl.pathname !== '/telegram/webhook') throw new Error();
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['TELEGRAM_WEBHOOK_URL'],
      message: 'A public HTTPS URL ending with /telegram/webhook is required when Telegram quick entry is enabled.',
    });
  }
  if (value.TELEGRAM_WEBHOOK_SECRET.length < 16) {
    context.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'Must be at least 16 characters when Telegram quick entry is enabled.' });
  }
  if (!/^[A-Za-z0-9_]{5,32}$/.test(value.TELEGRAM_BOT_USERNAME)) {
    context.addIssue({ code: 'custom', path: ['TELEGRAM_BOT_USERNAME'], message: 'A valid username without @ is required when Telegram quick entry is enabled.' });
  }
  try {
    new URL(value.WEB_APP_URL);
  } catch {
    context.addIssue({ code: 'custom', path: ['WEB_APP_URL'], message: 'A valid URL is required when Telegram quick entry is enabled.' });
  }
  if (value.PREMIUM_CHECKOUT_URL) {
    try {
      new URL(value.PREMIUM_CHECKOUT_URL);
    } catch {
      context.addIssue({ code: 'custom', path: ['PREMIUM_CHECKOUT_URL'], message: 'Must be a valid URL.' });
    }
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.TELEGRAM_DEFAULT_TIMEZONE }).format();
  } catch {
    context.addIssue({ code: 'custom', path: ['TELEGRAM_DEFAULT_TIMEZONE'], message: 'Must be a valid IANA timezone.' });
  }
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    '✖ Invalid environment configuration:\n',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const isProd = env.NODE_ENV === 'production';

/** Eskiz can only be called once the cabinet credentials are present. */
export const eskizConfigured = Boolean(env.ESKIZ_EMAIL && env.ESKIZ_PASSWORD);
