import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const mocks = vi.hoisted(() => ({ active: vi.fn(), transaction: vi.fn(), save: vi.fn(), notifications: true, push: true }));
vi.mock('../../src/config/env', () => ({
  env: { get NOTIFICATIONS_ENABLED() { return mocks.notifications; }, get PUSH_ENABLED() { return mocks.push; },
    NOTIFY_BUDGET_DEBOUNCE_MS: 300_000 },
  notificationAllowedUids: new Set(), notificationRecipientAllowed: () => true,
}));
vi.mock('../../src/push/devices.repository', () => ({ pushActive: mocks.active }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }), documentKey: (query: any, id: string) => ({ table: query.table, id }),
  Timestamp: { fromMillis: (n: number) => n },
  runSqlTransaction: mocks.transaction,
}));
import { scheduleBudgetCheck } from '../../src/notifications/queue.repository';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.notifications = true; mocks.push = true;
  mocks.active.mockResolvedValue(false);
  mocks.transaction.mockImplementation(work => work({ read: async () => ({ exists: false }), save: mocks.save }));
});
afterEach(() => vi.useRealTimers());
describe('legacy budget task timing', () => {
  it('defaults the actual env schema to 300000ms without a debounce override', async () => {
    vi.useRealTimers();
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', require.resolve('tsx'), '--eval',
      `const { env } = require(${JSON.stringify(resolve('src/config/env.ts'))}); console.log(env.NOTIFY_BUDGET_DEBOUNCE_MS);`,
    ], { env: { DOTENV_CONFIG_PATH: '/dev/null', WEB_APP_URL: 'https://example.test',
      FIREBASE_PROJECT_ID: 'test-project', TELEGRAM_BOT_TOKEN: '000000:test' }, timeout: 15_000 });
    expect(stdout.trim()).toBe('300000');
  });
  it('keeps Telegram-only users on the five-minute debounce', async () => {
    const now = Date.now();
    await scheduleBudgetCheck('telegram');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runAt: now + 300_000, expiresAt: now + 90 * 86400000,
    }), { merge: true });
  });
  it('skips the legacy task for device owners using the per-category push path', async () => {
    mocks.active.mockResolvedValue(true);
    await scheduleBudgetCheck('push');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('keeps legacy tasks when push is switched off even if a device remains stored', async () => {
    mocks.push = false;
    mocks.active.mockResolvedValue(true);
    await scheduleBudgetCheck('off');
    expect(mocks.active).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});
