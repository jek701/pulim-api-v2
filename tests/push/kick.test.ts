import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ delivery: vi.fn(), planner: vi.fn() }));
vi.mock('../../src/config/env', () => ({ env: { NOTIFICATIONS_ENABLED: true, BACKGROUND_JOBS_ENABLED: true } }));
vi.mock('../../src/notifications/delivery', () => ({ runDelivery: mocks.delivery }));
vi.mock('../../src/push/planner', () => ({ planPushUser: mocks.planner }));
vi.mock('../../src/utils/logger', () => ({ logger: { error: vi.fn() } }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useRealTimers(); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
describe('API push shutdown drain', () => {
  it('awaits delivery and planning already running and stops new or coalesced kicks', async () => {
    const delivery = deferred(); const planner = deferred();
    mocks.delivery.mockReturnValue(delivery.promise);
    mocks.planner.mockReturnValue(planner.promise);
    const { kickDelivery, kickPushPlanning, drainPushKicks } = await import('../../src/push/kick');
    kickDelivery(); kickDelivery(); kickPushPlanning('u'); kickPushPlanning('u');
    await vi.waitFor(() => { expect(mocks.delivery).toHaveBeenCalledOnce(); expect(mocks.planner).toHaveBeenCalledOnce(); });
    let done = false;
    const drain = drainPushKicks().then(() => { done = true; });
    kickDelivery(); kickPushPlanning('new');
    await Promise.resolve(); expect(done).toBe(false);
    delivery.resolve();
    await Promise.resolve(); expect(done).toBe(false);
    planner.resolve(); await drain;
    expect(mocks.delivery).toHaveBeenCalledOnce(); expect(mocks.planner).toHaveBeenCalledOnce();
  });
  it('bounds the drain when a provider or planner never settles', async () => {
    mocks.delivery.mockReturnValue(new Promise(() => undefined));
    const { kickDelivery, drainPushKicks } = await import('../../src/push/kick');
    kickDelivery();
    await vi.waitFor(() => expect(mocks.delivery).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const drain = drainPushKicks(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(drain).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
