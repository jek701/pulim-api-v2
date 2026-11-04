import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  closeApns: vi.fn(), closeDb: vi.fn(), drain: vi.fn(), handlers: new Map<string, (...args: any[]) => void>(),
}));
vi.mock('../../src/config/env', () => ({ env: {
  BACKGROUND_JOBS_ENABLED: true, NOTIFICATIONS_ENABLED: true, NOTIFY_EMBEDDED: false,
} }));
vi.mock('../../src/db/database', () => ({ checkDatabase: async () => {}, database: () => ({}), closeDatabase: mocks.closeDb }));
vi.mock('../../src/db/syncIndex', () => ({ initOfflineSync: async () => false }));
vi.mock('../../src/db/syncMaintenance', () => ({ startSyncMaintenance: () => ({ stop() {} }) }));
vi.mock('../../src/config/firebaseAuth', () => ({ admin: { apps: [] } }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/app', () => ({ createApp: () => ({ listen: () => ({ close: (done: () => void) => done() }) }) }));
vi.mock('../../src/telegram/client', () => ({ setMyCommands: vi.fn(), setWebhook: vi.fn() }));
vi.mock('../../src/telegram/fxQueue.service', () => ({ startFxQueue: () => ({ stop: async () => {} }) }));
vi.mock('../../src/routes/telegramWebhook.routes', () => ({ drainTelegramUpdates: async () => {}, recoverTelegramUpdates: async () => {} }));
vi.mock('../../src/notifications/loops', () => ({ startNotificationLoops: () => ({ stop: async () => {} }) }));
vi.mock('../../src/communications/repository', () => ({ runCommunicationDispatch: async () => {} }));
vi.mock('../../src/push/apns', () => ({ closeApns: mocks.closeApns }));
vi.mock('../../src/push/kick', () => ({ drainPushKicks: mocks.drain }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.handlers.clear();
  vi.spyOn(process, 'once').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
    mocks.handlers.set(event, handler); return process;
  }) as typeof process.once);
});
afterEach(() => vi.restoreAllMocks());
describe('process shutdown', () => {
  it.each(['server', 'worker'])('drains API kicks and closes APNs when %s stops', async entry => {
    let finish!: () => void;
    mocks.drain.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    if (entry === 'server') await import('../../src/server');
    else await import('../../src/worker');
    await vi.waitFor(() => expect(mocks.handlers.has('SIGTERM')).toBe(true));
    mocks.handlers.get('SIGTERM')!();
    expect(mocks.drain).toHaveBeenCalledOnce();
    expect(mocks.closeDb).not.toHaveBeenCalled();
    expect(mocks.closeApns).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(mocks.closeApns).toHaveBeenCalledOnce());
    expect(mocks.closeDb).toHaveBeenCalledOnce();
    mocks.handlers.get('SIGINT')!();
    expect(mocks.closeApns).toHaveBeenCalledOnce();
  });
});
