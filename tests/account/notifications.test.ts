import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ read: vi.fn(), patch: vi.fn(), create: vi.fn() }));
vi.mock('../../src/config/env', () => ({
  env: { NOTIFICATIONS_ENABLED: true },
  notificationAllowedUids: new Set(['synthetic']),
  notificationRecipientAllowed: () => true,
}));
vi.mock('../../src/db/documents', async (importActual) => ({
  ...(await importActual<typeof import('../../src/db/documents')>()),
  readDocument: state.read,
  patchDocument: state.patch,
}));
vi.mock('../../src/push/planner', () => ({ runPushPlanner: async () => 0 }));
vi.mock('../../src/push/apns', () => ({ apnsConfigured: () => false }));
vi.mock('../../src/push/devices.repository', () => ({ enabledDevices: async () => [] }));
vi.mock('../../src/push/kick', () => ({ kickDelivery: vi.fn() }));
vi.mock('../../src/notifications/collectors/daily', () => ({ collectDaily: vi.fn() }));
vi.mock('../../src/notifications/collectors/budget', () => ({ collectBudgetAlerts: vi.fn() }));
vi.mock('../../src/notifications/queue.repository', () => ({
  createNotification: state.create,
  recoverExpiredBudgetTasks: async () => 0,
  listDueBudgetTasks: async () => [],
}));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn() } }));
import { runPlanner } from '../../src/notifications/planner';

describe('notification planner after deletion', () => {
  it.each([
    { exists: false, data: undefined },
    { exists: true, data: { deletionRequestedAt: 1, notifications: { nextDailyAt: 1 } } },
  ])('skips a missing/deleting profile without enqueuing or updating it', async (document) => {
    state.read.mockResolvedValue({ id: 'synthetic', ...document });
    await expect(runPlanner(1000)).resolves.toMatchObject({ queued: 0 });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.patch).not.toHaveBeenCalled();
  });
});
