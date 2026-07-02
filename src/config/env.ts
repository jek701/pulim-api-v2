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

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL_FREE: z.string().default('claude-haiku-4-5-20251001'),
  AI_MODEL_PREMIUM: z.string().default('claude-sonnet-4-6'),

  AI_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
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
