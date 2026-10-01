import { createHash } from 'node:crypto';
import { env } from '../config/env';
import { normalizeUsage, openai, recordAiUsage } from '../services/ai.service';
import { logger } from '../utils/logger';
import type { MonthlyPayload, WeeklyPayload } from './types';

const weeklySchema = {
  type: 'object', additionalProperties: false,
  properties: { insight: { type: 'string' } }, required: ['insight'],
} as const;
const monthlySchema = {
  type: 'object', additionalProperties: false,
  properties: { insight: { type: 'string' }, tip: { type: 'string' } }, required: ['insight', 'tip'],
} as const;

function safetyIdentifier(uid: string): string {
  return `pulim-${createHash('sha256').update(uid).digest('hex').slice(0, 24)}`;
}

async function generate<T extends Record<string, string>>(
  uid: string,
  feature: 'weekly_report' | 'monthly_report',
  language: string,
  input: string,
  schema: typeof weeklySchema | typeof monthlySchema,
): Promise<T | null> {
  if (!env.NOTIFY_AI_ENABLED || !env.OPENAI_API_KEY) return null;
  const startedAt = Date.now();
  try {
    const response = await openai().responses.create({
      model: env.NOTIFY_AI_MODEL,
      instructions: `You are Pulim AI. Give a concise, factual personal-finance observation in ${language}. Do not invent data or use markdown.`,
      input,
      max_output_tokens: env.NOTIFY_AI_MAX_OUTPUT_TOKENS,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low', format: { type: 'json_schema', name: feature, strict: true, schema } },
      store: false,
      safety_identifier: safetyIdentifier(uid),
    }, { signal: AbortSignal.timeout(env.NOTIFY_AI_TIMEOUT_MS) });
    await recordAiUsage({
      uid, feature, model: env.NOTIFY_AI_MODEL, usage: normalizeUsage(response.usage),
      latencyMs: Date.now() - startedAt, success: true,
    });
    return JSON.parse(response.output_text) as T;
  } catch (error) {
    await recordAiUsage({
      uid, feature, model: env.NOTIFY_AI_MODEL, usage: null,
      latencyMs: Date.now() - startedAt, success: false,
    });
    logger.warn({ err: error, uid, feature }, 'notify.ai.failed');
    return null;
  }
}

export async function addWeeklyInsight(uid: string, language: string, payload: WeeklyPayload): Promise<void> {
  if (payload.empty) return;
  const result = await generate<{ insight: string }>(uid, 'weekly_report', language, JSON.stringify({
    expense: payload.expense,
    previousWeekChangePercent: payload.expenseChangePercent,
    topCategories: payload.topCategories,
  }), weeklySchema);
  if (result?.insight) payload.aiInsight = result.insight;
}

export async function addMonthlyInsight(uid: string, language: string, payload: MonthlyPayload): Promise<void> {
  const result = await generate<{ insight: string; tip: string }>(uid, 'monthly_report', language, JSON.stringify({
    income: payload.income,
    expense: payload.expense,
    topCategories: payload.topCategories,
    exceededBudgets: payload.exceededBudgets,
    subscriptionsTotal: payload.subscriptionsTotal,
  }), monthlySchema);
  if (result?.insight && result.tip) payload.aiInsight = result;
}
