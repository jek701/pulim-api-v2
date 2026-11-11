import 'dotenv/config';
import { z } from 'zod';
/** Shared with the full server env; standalone eval needs no Firebase/Telegram config. */
export const aiSettingsShape = {
  AI_AGENT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  AI_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(6).default(4),
  AI_REASONING_FREE: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('low'),
  AI_REASONING_PREMIUM: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('low'),
  AI_REASONING_ESCALATED: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('medium'),
  AI_MODEL_FREE: z.string().default('gpt-5.4-mini'),
  AI_MODEL_PREMIUM: z.string().default('gpt-5.6-terra'),
  AI_MODEL_PLAN_SETUP: z.string().default('gpt-5.4-mini'),
  AI_MODEL_FORECAST: z.string().default('gpt-5.4-mini'),

  AI_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  AI_MAX_HISTORY_MESSAGES: z.coerce.number().int().positive().max(40).default(12),
  AI_MAX_OUTPUT_TOKENS_FREE: z.coerce.number().int().positive().max(25_000).default(1_600),
  AI_MAX_OUTPUT_TOKENS_PREMIUM: z.coerce.number().int().positive().max(25_000).default(6_000),
  AI_MAX_OUTPUT_TOKENS_FORECAST: z.coerce.number().int().positive().max(25_000).default(3_000),
  AI_PREMIUM_MESSAGES_PER_PERIOD: z.coerce.number().int().positive().default(150),
};
export const agentSettings = z.object(aiSettingsShape).parse(process.env);
