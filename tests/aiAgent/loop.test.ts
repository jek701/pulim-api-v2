import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResponseStreamEvent,
  ResponseOutputItem,
  ResponseCreateParamsStreaming,
} from 'openai/resources/responses/responses';
vi.mock('../../src/ai/agent/settings', () => ({
  agentSettings: {
    AI_MODEL_FREE: 'free',
    AI_MAX_TOOL_ROUNDS: 4,
    AI_REASONING_FREE: 'low',
    AI_REASONING_PREMIUM: 'low',
    AI_REASONING_ESCALATED: 'medium',
    AI_MAX_OUTPUT_TOKENS_FREE: 1600,
    AI_MAX_OUTPUT_TOKENS_PREMIUM: 6000,
  },
}));
import { runAgent, type AgentClient, type AgentOptions } from '../../src/ai/agent/loop';
import { createFixtureDataSource } from '../../src/ai/agent/fixtureDataSource';
import { agentSettings as env } from '../../src/ai/agent/settings';
import { fixtureNow } from '../fixtures/aiAgentUser';
const fn = (
  id = 'call',
  name = 'calculate',
  args: unknown = { expression: '2+2' },
): ResponseOutputItem => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const reasoning: ResponseOutputItem = {
  type: 'reasoning',
  id: 'r',
  summary: [],
  encrypted_content: 'encrypted',
};
const terminal = (
  output: ResponseOutputItem[] = [],
  type = 'response.completed',
  reason?: string,
) =>
  ({
    type,
    response: {
      output,
      output_text: 'SHOULD NEVER REPLACE DELTAS',
      incomplete_details: reason ? { reason } : null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  }) as unknown as ResponseStreamEvent;
const delta = (text: string) =>
  ({ type: 'response.output_text.delta', delta: text }) as ResponseStreamEvent;
function fake(turns: ResponseStreamEvent[][]) {
  const params: ResponseCreateParamsStreaming[] = [];
  const create = vi.fn(async (p: ResponseCreateParamsStreaming) => {
    params.push(p);
    const events = turns[params.length - 1];
    if (!events) throw new Error('Unexpected model call');
    return (async function* () {
      for (const e of events) yield e;
    })();
  });
  return { client: { responses: { create } } satisfies AgentClient, params, create };
}
const opts = (client: AgentClient, extra: Partial<AgentOptions> = {}): AgentOptions => ({
  uid: 'u',
  model: env.AI_MODEL_FREE,
  language: 'Russian',
  history: [],
  userMessage: 'Сколько?',
  signal: new AbortController().signal,
  dataSource: createFixtureDataSource({}),
  now: fixtureNow,
  client,
  ...extra,
});
beforeEach(() => {
  env.AI_MAX_TOOL_ROUNDS = 4;
  vi.useRealTimers();
});
describe('stateless streaming tool loop', () => {
  it('replays reasoning and tool output; streams exact text, statuses and per-call usage', async () => {
    const f = fake([[terminal([reasoning, fn()])], [delta('Ответ '), delta('4'), terminal()]]);
    const deltas: string[] = [],
      statuses: any[] = [],
      metrics: any[] = [];
    const result = await runAgent(
      opts(f.client, {
        onDelta: (d) => {
          deltas.push(d);
        },
        onStatus: (s) => statuses.push(s),
        onCall: (m) => {
          metrics.push(m);
        },
      }),
    );
    expect(result.text).toBe('Ответ 4');
    expect(deltas).toEqual(['Ответ ', '4']);
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toEqual([{ name: 'calculate', ok: true }]);
    expect(f.params[1].input).toEqual(
      expect.arrayContaining([
        reasoning,
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call',
          output: '{"result":4}',
        }),
      ]),
    );
    expect(statuses.map((s) => s.stage)).toEqual(['thinking', 'tool', 'writing']);
    expect(f.params[0]).toMatchObject({
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
    });
    expect(metrics).toHaveLength(2);
    expect(metrics[1]).toMatchObject({
      round: 2,
      rounds: 2,
      toolCallCount: 1,
      toolErrorCount: 0,
      hitRoundLimit: false,
    });
    expect(result.followups.length).toBeGreaterThan(0);
  });
  it('starts independent tools concurrently', async () => {
    let resolveA!: (v: any[]) => void, resolveB!: (v: any[]) => void;
    const a = vi.fn(
        () =>
          new Promise<any[]>((r) => {
            resolveA = r;
          }),
      ),
      b = vi.fn(
        () =>
          new Promise<any[]>((r) => {
            resolveB = r;
          }),
      );
    const ds = createFixtureDataSource({});
    ds.plannedExpenses = a;
    // upcoming calls independently invoke plannedExpenses; neither can finish first.
    const f = fake([
      [
        terminal([
          fn('a', 'get_upcoming', { days_ahead: 1 }),
          fn('b', 'get_upcoming', { days_ahead: 2 }),
        ]),
      ],
      [delta('Done'), terminal()],
    ]);
    ds.plannedExpenses = vi.fn().mockImplementationOnce(a).mockImplementationOnce(b);
    const promise = runAgent(opts(f.client, { dataSource: ds }));
    await vi.waitFor(() => {
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });
    resolveA([]);
    resolveB([]);
    const result = await promise;
    expect(result.toolCalls).toHaveLength(2);
  });
  it('forces none after maximum tool rounds and escalates reasoning on call 3', async () => {
    env.AI_MAX_TOOL_ROUNDS = 2;
    const f = fake([[terminal([fn('a')])], [terminal([fn('b')])], [delta('4'), terminal()]]);
    const result = await runAgent(opts(f.client));
    expect(f.params.map((p) => p.tool_choice)).toEqual(['auto', 'auto', 'none']);
    expect(f.params.map((p) => p.reasoning?.effort)).toEqual(['low', 'low', 'medium']);
    expect(result.hitRoundLimit).toBe(true);
  });
  it('returns tool errors to the model and chooses localized followups', async () => {
    const f = fake([
      [
        terminal([
          fn('bad', 'calculate', { expression: '1/0' }),
          fn('s', 'get_spending_stats', {}),
        ]),
      ],
      [delta('Нет данных'), terminal()],
    ]);
    const result = await runAgent(opts(f.client));
    expect(result.toolCalls.every((t) => !t.ok)).toBe(true);
    const outputs = (f.params[1].input as any[]).filter((i) => i.type === 'function_call_output');
    expect(outputs.every((o) => JSON.parse(o.output).error)).toBe(true);
    expect(result.followups[0]).toBe('Сравни с предыдущим периодом');
  });
  it('forwards separators between text-producing rounds and never overwrites text', async () => {
    const f = fake([
      [delta('A'), terminal([fn()])],
      [delta('B'), delta('C'), terminal()],
    ]);
    const deltas: string[] = [];
    const result = await runAgent(
      opts(f.client, {
        onDelta: (d) => {
          deltas.push(d);
        },
      }),
    );
    expect(deltas).toEqual(['A', '\n\n', 'B', 'C']);
    expect(result.text).toBe(deltas.join(''));
  });
  it('aborts during stream before running tools or calling model again', async () => {
    const abort = new AbortController();
    const f = fake([
      [delta('A'), terminal([fn()])],
      [delta('B'), terminal()],
    ]);
    await expect(
      runAgent(opts(f.client, { signal: abort.signal, onDelta: () => abort.abort() })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.create).toHaveBeenCalledOnce();
  });
  it('aborts during context and tool execution without waiting for blocked I/O', async () => {
    const controller = new AbortController(),
      ds = createFixtureDataSource({});
    ds.profile = () => new Promise(() => {});
    const f = fake([]),
      pending = runAgent(opts(f.client, { dataSource: ds, signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.create).not.toHaveBeenCalled();
    const abort = new AbortController(),
      ds2 = createFixtureDataSource({});
    ds2.plannedExpenses = () => new Promise(() => {});
    const f2 = fake([[terminal([fn('a', 'get_upcoming', { days_ahead: 1 })])]]);
    const p2 = runAgent(
      opts(f2.client, {
        dataSource: ds2,
        signal: abort.signal,
        onStatus: (s) => {
          if (s.stage === 'tool') queueMicrotask(() => abort.abort());
        },
      }),
    );
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(f2.create).toHaveBeenCalledOnce();
  });
  it('times out a tool after 5s, reports the error and continues', async () => {
    vi.useFakeTimers();
    const ds = createFixtureDataSource({});
    ds.plannedExpenses = () => new Promise(() => {});
    const f = fake([
      [terminal([fn('a', 'get_upcoming', { days_ahead: 1 })])],
      [delta('Unavailable'), terminal()],
    ]);
    const promise = runAgent(opts(f.client, { dataSource: ds }));
    await vi.advanceTimersByTimeAsync(5001);
    const result = await promise;
    expect(result.toolCalls).toEqual([{ name: 'get_upcoming', ok: false }]);
    expect(JSON.stringify(f.params[1].input)).toContain('timed out');
  });
  it('preserves token-limit partial text, rejects filtered/failed/empty and truncated streams', async () => {
    const f = fake([[delta('Partial'), terminal([], 'response.incomplete', 'max_output_tokens')]]);
    expect(await runAgent(opts(f.client))).toMatchObject({
      text: 'Partial',
      incompleteReason: 'max_output_tokens',
    });
    for (const events of [
      [delta('Blocked'), terminal([], 'response.incomplete', 'content_filter')],
      [terminal([], 'response.failed')],
      [terminal()],
      [delta('Lost')],
    ]) {
      const metrics = vi.fn(),
        f2 = fake([events]);
      await expect(runAgent(opts(f2.client, { onCall: metrics }))).rejects.toThrow();
      expect(metrics).toHaveBeenCalledOnce();
      expect(metrics.mock.calls[0][0].success).toBe(false);
    }
  });
});

it('registers and executes plan tools only for requests carrying a forecast', async () => {
  const p = {
    today: '2026-11-11',
    currency: 'UZS',
    balance: 100,
    everydayPerDay: 10,
    headline: { mode: 'date' as const, day: '2026-11-12', value: 80 },
    days: [
      { d: '2026-11-11', close: 100 },
      { d: '2026-11-12', close: 80 },
    ],
    items: [],
    nextIncome: null,
    pendingIncomes: 1,
  };
  const f = fake([
    [terminal([fn('p', 'simulate_purchase', { amount: 90, day: p.today, installments: null })])],
    [delta('Checked'), terminal()],
  ]);
  const result = await runAgent(opts(f.client, { planContext: p }));
  expect(f.params[0].tools?.map((t) => ('name' in t ? t.name : ''))).toEqual(
    expect.arrayContaining(['simulate_purchase', 'get_plan_forecast']),
  );
  expect(f.params[0].instructions).toContain('never re-estimate');
  expect(JSON.stringify(f.params[0].input)).toContain('Plan forecast (computed by the app)');
  expect(JSON.stringify(f.params[1].input)).toContain('shortBy');
  expect(result.toolCalls).toEqual([{ name: 'simulate_purchase', ok: true }]);
  const without = fake([[delta('Normal'), terminal()]]);
  await runAgent(opts(without.client));
  expect(without.params[0].tools?.map((t) => ('name' in t ? t.name : ''))).not.toContain(
    'simulate_purchase',
  );
  expect(JSON.stringify(without.params[0].input)).not.toContain('Plan forecast');
  expect(without.params[0].instructions).not.toContain('never re-estimate');
});
