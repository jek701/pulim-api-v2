import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ profile: null as any, categories: [] as any[] }));
vi.mock('../../src/repositories/profile.repository', () => ({
  profileRef: (id: string) => ({ id }),
  getProfile: async () => state.profile,
}));
vi.mock('../../src/db/documents', () => ({
  documentKey: (_table: any, id: string) => ({ id }),
  queryTable: (table: string) => table,
  filterQuery: (q: any) => q,
  limitQuery: (q: any) => q,
  readDocument: async () => ({ empty: !state.categories.length }),
  saveDocument: async (_ref: any, data: any) => {
    state.profile = { ...state.profile, ...data };
  },
  writeBatch: () => ({
    save: (_ref: any, data: any) => state.categories.push(data),
    commit: async () => undefined,
  }),
}));
vi.mock('../../src/notifications/settings', () => ({ ensureNotificationDefaults: vi.fn() }));
vi.mock('../../src/notifications/queue.repository', () => ({ queueTrialStarted: vi.fn() }));
import { bootstrap } from '../../src/services/profile.service';

describe('bootstrap after deletion', () => {
  beforeEach(() => {
    state.profile = null;
    state.categories = [];
  });
  it('creates a clean profile and default categories on a new sign-in', async () => {
    const profile = await bootstrap('synthetic-user', {
      firebase: { sign_in_provider: 'password', identities: {} },
    } as any);
    expect(profile).toMatchObject({ createdAt: expect.any(Number) });
    expect(profile).not.toHaveProperty('isPremium');
    expect(profile).not.toHaveProperty('subscription');
    expect(profile).not.toHaveProperty('deletionRequestedAt');
    expect(state.categories.length).toBeGreaterThan(0);
    expect(state.categories.every((c) => c.userId === 'synthetic-user')).toBe(true);
  });
  it('does not seed anything during a partial deletion', async () => {
    state.profile = { deletionRequestedAt: 1 };
    await expect(bootstrap('synthetic-user', {} as any)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    expect(state.categories).toEqual([]);
  });
});
