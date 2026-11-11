import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  aiConfigured: vi.fn(),
  agentEnabled: vi.fn(),
  runChatAgent: vi.fn(),
  assembleSnapshot: vi.fn(),
  selectChatModel: vi.fn(),
  consumeAiMessage: vi.fn(),
  refundAiMessage: vi.fn(),
  createChat: vi.fn(),
  appendUserMessage: vi.fn(),
  appendAssistantMessage: vi.fn(),
  countChats: vi.fn(),
  loadChatHistory: vi.fn(),
  streamChat: vi.fn(),
  normalizeUsage: vi.fn(),
  recordAiUsage: vi.fn(),
  getIsPremium: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/services/ai.service', () => mocks);
vi.mock('../../src/services/entitlement.service', () => ({ getIsPremium: mocks.getIsPremium }));
import { postChat } from '../../src/controllers/ai.controller';
function request() {
  const res: any = new EventEmitter(),
    chunks: string[] = [],
    headers: Record<string, string> = {};
  res.status = vi.fn(() => res);
  res.setHeader = vi.fn((k, v) => {
    headers[k] = v;
  });
  res.flushHeaders = vi.fn();
  res.write = vi.fn((s) => {
    chunks.push(s);
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
    res.emit('finish');
  });
  const next = vi.fn(),
    req: any = { uid: 'u', body: { message: 'Сколько?', language: 'ru' } };
  return {
    res,
    req,
    next,
    chunks,
    headers,
    start: () => postChat(req, res, next),
    done: async () => {
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
      expect(next).not.toHaveBeenCalled();
    },
  };
}
const events = (chunks: string[]) =>
  chunks
    .filter((c) => c.startsWith('event:'))
    .map((c) => ({ event: c.match(/^event: (.*)/)![1], data: JSON.parse(c.split('data: ')[1]) }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  mocks.aiConfigured.mockReturnValue(true);
  mocks.agentEnabled.mockReturnValue(true);
  mocks.getIsPremium.mockResolvedValue(true);
  mocks.createChat.mockResolvedValue('chat');
  mocks.selectChatModel.mockReturnValue('model');
  mocks.runChatAgent.mockImplementation(async (o) => {
    o.onStatus({ stage: 'thinking' });
    o.onStatus({ stage: 'tool', tool: 'calculate', label: 'Считаю' });
    o.onStatus({ stage: 'writing' });
    o.onDelta('Ответ');
    return { text: 'Ответ', incompleteReason: null, followups: ['Дальше?'] };
  });
});
describe('SSE controller without network or database', () => {
  it('flushes before context and sends ordered events with followups', async () => {
    const r = request();
    r.start();
    await r.done();
    expect(r.headers).toMatchObject({
      'X-Accel-Buffering': 'no',
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    expect(events(r.chunks).map((e) => e.event)).toEqual([
      'meta',
      'status',
      'status',
      'status',
      'delta',
      'done',
    ]);
    expect(events(r.chunks)[1].data).toEqual({ stage: 'thinking' });
    expect(events(r.chunks).at(-1)?.data).toMatchObject({
      text: 'Ответ',
      chatId: 'chat',
      incomplete: false,
      followups: ['Дальше?'],
    });
    expect(r.res.flushHeaders.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runChatAgent.mock.invocationCallOrder[0],
    );
    expect(mocks.assembleSnapshot).not.toHaveBeenCalled();
    expect(mocks.recordAiUsage).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessage).toHaveBeenCalledWith('chat', 'Ответ');
  });
  it('AI_AGENT_ENABLED=false uses the old snapshot and stream only', async () => {
    mocks.agentEnabled.mockReturnValue(false);
    mocks.assembleSnapshot.mockResolvedValue('snapshot');
    mocks.streamChat.mockImplementation(async () =>
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'Old' };
        yield { type: 'response.completed', response: { output_text: 'Old' } };
      })(),
    );
    const r = request();
    r.start();
    await r.done();
    expect(mocks.runChatAgent).not.toHaveBeenCalled();
    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: 'snapshot' }),
    );
    expect(events(r.chunks).at(-1)?.data.followups).toEqual([]);
    expect(mocks.recordAiUsage).toHaveBeenCalledOnce();
    expect(r.res.flushHeaders.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assembleSnapshot.mock.invocationCallOrder[0],
    );
  });
  it('refunds token-limit truncation and failed/empty calls, preserves useful partial answers', async () => {
    mocks.runChatAgent.mockImplementationOnce(async (o) => {
      o.onDelta('Partial');
      return { incompleteReason: 'max_output_tokens', followups: [] };
    });
    const r = request();
    r.start();
    await r.done();
    expect(mocks.refundAiMessage).toHaveBeenCalledOnce();
    expect(events(r.chunks).at(-1)?.data.incomplete).toBe(true);
    mocks.runChatAgent.mockRejectedValueOnce(new Error('Provider failed'));
    const r2 = request();
    r2.start();
    await r2.done();
    expect(mocks.refundAiMessage).toHaveBeenCalledTimes(2);
    expect(events(r2.chunks).at(-1)?.event).toBe('error');
  });
  it('heartbeats while context is loading and clears timers on finish/disconnect', async () => {
    vi.useFakeTimers();
    let complete!: (v: any) => void;
    mocks.runChatAgent.mockImplementationOnce(
      () =>
        new Promise((r) => {
          complete = r;
        }),
    );
    const r = request();
    r.start();
    await vi.advanceTimersByTimeAsync(15001);
    expect(r.chunks).toContain(': ping\n\n');
    complete({ incompleteReason: null, followups: [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(r.res.end).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    let signal!: AbortSignal;
    mocks.runChatAgent.mockImplementationOnce(
      (o) =>
        new Promise((_, reject) => {
          signal = o.signal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const r2 = request();
    r2.start();
    await vi.advanceTimersByTimeAsync(1);
    r2.res.emit('close');
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(events(r2.chunks).some((e) => e.event === 'error')).toBe(false);
    vi.useRealTimers();
  });
});

it('passes planContext to the agent only, without persisting or echoing it', async () => {
  const r = request();
  r.req.body.planContext = { today: '2026-11-11', balance: 123456789 };
  r.start();
  await r.done();
  expect(mocks.runChatAgent).toHaveBeenCalledWith(
    expect.objectContaining({ planContext: r.req.body.planContext }),
  );
  expect(mocks.createChat).toHaveBeenCalledWith('u', 'Сколько?');
  expect(r.chunks.join('')).not.toContain('123456789');
  mocks.agentEnabled.mockReturnValue(false);
  mocks.streamChat.mockImplementation(async () =>
    (async function* () {
      yield { type: 'response.output_text.delta', delta: 'Legacy' };
    })(),
  );
  const legacy = request();
  legacy.req.body.planContext = r.req.body.planContext;
  legacy.start();
  await legacy.done();
  expect(mocks.streamChat.mock.calls[0][0]).not.toHaveProperty('planContext');
});
