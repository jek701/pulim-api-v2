import { createHash } from 'node:crypto';
import type { ResponseUsage } from 'openai/resources/responses/responses';
export interface AiTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}
export const MODEL_PRICING_PER_MILLION: Record<
  string,
  {
    input: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
  }
> = {
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.2, output: 1.25 },
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6 },
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
  'gpt-5.6': { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
  // Audio input tokens dominate transcription cost; text prompt tokens are priced the same here.
  'gpt-4o-mini-transcribe': { input: 3, cachedInput: 3, cacheWrite: 3, output: 5 },
};
export function normalizeUsage(usage?: ResponseUsage | null): AiTokenUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens,
  };
}
export function estimateCostUsd(model: string, usage: AiTokenUsage): number | null {
  const pricing = MODEL_PRICING_PER_MILLION[model];
  if (!pricing) return null;
  const regularInput = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens,
  );
  const total =
    regularInput * pricing.input +
    usage.cachedInputTokens * pricing.cachedInput +
    usage.cacheWriteTokens * pricing.cacheWrite +
    usage.outputTokens * pricing.output;
  return Number((total / 1000000).toFixed(8));
}
export const stableUserHash = (uid: string): string =>
  createHash('sha256').update(uid).digest('hex').slice(0, 32);
