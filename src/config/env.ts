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
  DEBUG_TELEGRAM_AUTH: boolish,

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
