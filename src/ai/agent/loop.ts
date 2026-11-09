import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';
import { agentSettings as env } from './settings';
import { openai } from './client';
import { normalizeUsage, stableUserHash, type AiTokenUsage } from './usage';
import type { ChatTurn } from '../../services/ai.service';
import type { AgentDataSource } from './dataSource';
import { buildAgentContext } from './context';
import { AGENT_INSTRUCTIONS } from './prompt';
import { executeTool, toolDefinitions } from './tools';
import {
  chooseFollowups,
  resolveLanguageCode,
  statusLabel,
  type AgentStatus,
  type LanguageCode,
} from './labels';
export interface AgentClient {
  responses: {
    create(
      params: ResponseCreateParamsStreaming,
      options: { signal: AbortSignal },
    ): PromiseLike<AsyncIterable<ResponseStreamEvent>>;
  };
}
export interface CallMetric {
  round: number;
  usage: AiTokenUsage | null;
  toolNames: string[];
  reasoning: ReasoningEffort;
  latencyMs: number;
  success: boolean;
  incompleteReason: string | null;
  rounds?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  hitRoundLimit?: boolean;
}
export interface AgentOptions {
  uid: string;
  dataSource: AgentDataSource;
  model: string;
  language: string;
  languageCode?: LanguageCode;
  history: ChatTurn[];
  userMessage: string;
  signal: AbortSignal;
  reasoning?: ReasoningEffort;
  onStatus?: (status: AgentStatus) => void;
  onDelta?: (delta: string) => void | Promise<void>;
  onCall?: (metric: CallMetric) => void | Promise<void>;
  client?: AgentClient;
  now?: number;
  additionalInstructions?: string;
}
/** Race read-only work with disconnect/timeout and always remove its timer/listener. */
async function bounded<T>(work: PromiseLike<T>, signal: AbortSignal, timeout?: number): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (timeout)
          timer = setTimeout(() => reject(new Error('Tool timed out after 5 seconds')), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
export async function runAgent(opts: AgentOptions) {
  const language = opts.languageCode ?? resolveLanguageCode(opts.language);
  opts.onStatus?.({ stage: 'thinking' });
  opts.signal.throwIfAborted();
  const context = await bounded(buildAgentContext(opts.dataSource, opts.now), opts.signal);
  const input: ResponseInput = [
    { role: 'developer', content: context },
    ...opts.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.userMessage },
  ];
  const client: AgentClient = opts.client ?? openai();
  const toolCalls: { name: string; ok: boolean }[] = [];
  const usage: (AiTokenUsage | null)[] = [];
  let text = '',
    rounds = 0,
    toolRounds = 0,
    hitRoundLimit = false;
  let incompleteReason: 'max_output_tokens' | 'content_filter' | 'unknown' | null = null;
  const free = opts.model === env.AI_MODEL_FREE;
  for (;;) {
    opts.signal.throwIfAborted();
    rounds++;
    const forceFinal = toolRounds >= env.AI_MAX_TOOL_ROUNDS;
    if (forceFinal) hitRoundLimit = true;
    const effort =
      rounds >= 3
        ? env.AI_REASONING_ESCALATED
        : (opts.reasoning ?? (free ? env.AI_REASONING_FREE : env.AI_REASONING_PREMIUM));
    const startedAt = Date.now();
    let response: Response | undefined,
      roundText = '',
      callUsage: AiTokenUsage | null = null;
    let recorded = false;
    const metric = (success: boolean, names: string[], final: boolean): CallMetric => ({
      round: rounds,
      usage: callUsage,
      toolNames: names,
      reasoning: effort,
      latencyMs: Date.now() - startedAt,
      success,
      incompleteReason,
      ...(final
        ? {
            rounds,
            toolCallCount: toolCalls.length,
            toolErrorCount: toolCalls.filter((c) => !c.ok).length,
            hitRoundLimit,
          }
        : {}),
    });
    try {
      // Verified against installed responses.d.ts, not Chat Completions fields.
      const stream = await bounded(
        client.responses.create(
          {
            model: opts.model,
            instructions: `${AGENT_INSTRUCTIONS}\n\nReply in ${opts.language}.${opts.additionalInstructions ? `\n\n${opts.additionalInstructions}` : ''}`,
            input: [...input],
            stream: true,
            store: false,
            include: ['reasoning.encrypted_content'],
            tools: toolDefinitions,
            tool_choice: forceFinal ? 'none' : 'auto',
            parallel_tool_calls: true,
            prompt_cache_key: `pulim-chat-${stableUserHash(opts.uid)}`,
            safety_identifier: `pulim-${stableUserHash(opts.uid)}`,
            max_output_tokens: free
              ? env.AI_MAX_OUTPUT_TOKENS_FREE
              : env.AI_MAX_OUTPUT_TOKENS_PREMIUM,
            reasoning: { effort },
            text: { verbosity: free ? 'low' : 'medium' },
          },
          { signal: opts.signal },
        ),
        opts.signal,
      );
      for await (const event of stream) {
        opts.signal.throwIfAborted();
        if (event.type === 'response.output_text.delta') {
          if (!roundText && event.delta) {
            opts.onStatus?.({ stage: 'writing' });
            if (text) {
              text += '\n\n';
              await opts.onDelta?.('\n\n');
            }
          }
          roundText += event.delta;
          text += event.delta;
          await opts.onDelta?.(event.delta);
        } else if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete' ||
          event.type === 'response.failed'
        ) {
          response = event.response;
          callUsage = normalizeUsage(response.usage);
          if (event.type === 'response.failed')
            throw Object.assign(new Error('OpenAI response failed'), { refundRequired: true });
          if (event.type === 'response.incomplete') {
            incompleteReason = response.incomplete_details?.reason ?? 'unknown';
            if (incompleteReason !== 'max_output_tokens' || !text.trim())
              throw Object.assign(new Error(`OpenAI response incomplete: ${incompleteReason}`), {
                refundRequired: true,
              });
          }
        } else if (event.type === 'error')
          throw Object.assign(new Error(event.message), { refundRequired: true });
      }
      opts.signal.throwIfAborted();
      if (!response) throw new Error('OpenAI stream ended before a terminal response');
      usage.push(callUsage);
      const calls = response.output.filter((item) => item.type === 'function_call');
      const final = !calls.length || forceFinal || incompleteReason !== null;
      if (!final) {
        for (const item of response.output) {
          // Only function tools are enabled; preserve reasoning and messages verbatim.
          if (item.type === 'function_call' || item.type === 'reasoning' || item.type === 'message')
            input.push(item);
          else throw new Error('Unexpected output item for function-only agent');
        }
        const results = await Promise.all(
          calls.map(async (call) => {
            opts.onStatus?.({
              stage: 'tool',
              tool: call.name,
              label: statusLabel(call.name, call.arguments, language),
            });
            let result: any;
            try {
              result = await bounded(
                executeTool(call.name, call.arguments, opts.dataSource, opts.now),
                opts.signal,
                5000,
              );
            } catch (err) {
              opts.signal.throwIfAborted();
              result = { error: err instanceof Error ? err.message : 'Tool failed' };
            }
            toolCalls.push({ name: call.name, ok: !result.error });
            return {
              type: 'function_call_output' as const,
              call_id: call.call_id,
              output: JSON.stringify(result),
            };
          }),
        );
        input.push(...results);
        toolRounds++;
      }
      if (final && !text.trim()) throw new Error('OpenAI returned an empty response');
      await opts.onCall?.(
        metric(
          !incompleteReason,
          calls.map((c) => c.name),
          final,
        ),
      );
      recorded = true;
      if (final) {
        if (!text.trim()) throw new Error('OpenAI returned an empty response');
        return {
          text,
          rounds,
          toolCalls,
          usage,
          incompleteReason,
          hitRoundLimit,
          followups: chooseFollowups(
            toolCalls.map((c) => c.name),
            language,
          ),
        };
      }
    } catch (err) {
      if (!recorded)
        await opts.onCall?.(
          metric(
            false,
            response?.output.filter((i) => i.type === 'function_call').map((i) => i.name) ?? [],
            true,
          ),
        );
      throw err;
    }
  }
}
