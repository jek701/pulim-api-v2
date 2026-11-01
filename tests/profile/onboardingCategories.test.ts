import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CATEGORIES,
  categorySeeds,
  customCategoryId,
  defaultCategoryId,
} from '../../src/domain/defaultCategories';
import { bootstrapSchema } from '../../src/domain/schemas';

const UID = 'user_1';
const NOW = 1_800_000_000_000;

// --- DB-free doubles: the document layer records what the service reads and writes. ---
const db = vi.hoisted(() => ({
  hasCategories: false,
  saved: [] as { id: string; data: Record<string, any>; options?: unknown }[],
  commits: 0,
}));
vi.mock('../../src/db/documents', async (importActual) => {
  const actual = await importActual<typeof import('../../src/db/documents')>();
  return {
    ...actual,
    readDocument: vi.fn(async () => ({ empty: !db.hasCategories })),
    writeBatch: () => ({
      save: (key: { id: string }, data: Record<string, any>, options?: unknown) =>
        db.saved.push({ id: key.id, data, options }),
      commit: async () => {
        db.commits += 1;
      },
    }),
    saveDocument: vi.fn(async () => undefined),
  };
});
vi.mock('../../src/repositories/profile.repository', () => ({
  profileRef: () => ({}),
  getProfile: async () => ({ id: 'user_1' }),
}));
vi.mock('../../src/notifications/settings', () => ({ ensureNotificationDefaults: async () => undefined }));
vi.mock('../../src/notifications/queue.repository', () => ({ queueTrialStarted: async () => undefined }));
const premium = vi.hoisted(() => ({ value: false }));
vi.mock('../../src/services/entitlement.service', () => ({ getIsPremium: async () => premium.value }));

const parse = (body: unknown) => bootstrapSchema.safeParse(body);
const food = { type: 'expense', name: 'Food' } as const;
const salary = { type: 'income', name: 'Salary' } as const;

describe('default category colors', () => {
  it('has no purple and keeps ids name+type based', () => {
    const purples = ['#5E5CE6', '#BF5AF2'];
    for (const category of DEFAULT_CATEGORIES) {
      expect(purples).not.toContain(category.color.toUpperCase());
      expect(category.color).not.toBe('#14B8A6');
      expect(category.color).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(defaultCategoryId(UID, 'expense', 'Other Income')).toBe('user_1__default__expense_other_income');
    expect(DEFAULT_CATEGORIES).toHaveLength(17);
  });
});

describe('bootstrap onboarding schema', () => {
  it('accepts an absent, null or empty body (legacy bootstrap)', () => {
    for (const body of [undefined, null, {}, { unrelated: 1 }]) {
      const result = parse(body);
      expect(result.success).toBe(true);
      expect((result as any).data.categories).toBeUndefined();
    }
  });

  it('accepts defaults + custom and trims names and icons', () => {
    const result = parse({
      categories: {
        defaults: [food, salary],
        custom: [{ type: 'expense', name: '  Coffee  ', icon: ' ☕ ', color: '#A2845E' }],
      },
    });
    expect(result.success).toBe(true);
    expect((result as any).data.categories.custom[0]).toEqual({
      type: 'expense',
      name: 'Coffee',
      icon: '☕',
      color: '#A2845E',
    });
  });

  it('requires at least one expense category', () => {
    expect(parse({ categories: { defaults: [salary], custom: [] } }).success).toBe(false);
    expect(parse({ categories: { defaults: [], custom: [] } }).success).toBe(false);
    expect(
      parse({ categories: { defaults: [salary], custom: [{ type: 'expense', name: 'Pets', icon: '🐶' }] } }).success,
    ).toBe(true);
  });

  it('rejects unknown defaults, wrong type/name pairs and bad types', () => {
    expect(parse({ categories: { defaults: [{ type: 'expense', name: 'Nope' }], custom: [] } }).success).toBe(false);
    expect(parse({ categories: { defaults: [{ type: 'income', name: 'Food' }, food], custom: [] } }).success).toBe(false);
    expect(parse({ categories: { defaults: [{ type: 'both', name: 'Food' }], custom: [] } }).success).toBe(false);
  });

  it('enforces name length 1..40 after trimming', () => {
    const custom = (name: string) => ({
      categories: { defaults: [food], custom: [{ type: 'expense', name, icon: '🐶' }] },
    });
    expect(parse(custom('x'.repeat(40))).success).toBe(true);
    expect(parse(custom('x'.repeat(41))).success).toBe(false);
    expect(parse(custom('   ')).success).toBe(false);
    expect(parse(custom('')).success).toBe(false);
  });

  it('allows at most 10 custom categories', () => {
    const custom = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ type: 'expense', name: `Cat ${i}`, icon: '🐶' }));
    expect(parse({ categories: { defaults: [], custom: custom(10) } }).success).toBe(true);
    expect(parse({ categories: { defaults: [], custom: custom(11) } }).success).toBe(false);
  });

  it('validates icon and color shape', () => {
    const custom = (extra: Record<string, unknown>) => ({
      categories: { defaults: [food], custom: [{ type: 'expense', name: 'Pets', icon: '🐶', ...extra }] },
    });
    expect(parse(custom({ icon: '' })).success).toBe(false);
    expect(parse(custom({ icon: 'x'.repeat(33) })).success).toBe(false);
    expect(parse(custom({ color: 'purple' })).success).toBe(false);
    expect(parse(custom({ color: '#12345' })).success).toBe(false);
  });

  it('requires both defaults and custom arrays when categories is present', () => {
    expect(parse({ categories: { defaults: [food] } }).success).toBe(false);
    expect(parse({ categories: { custom: [] } }).success).toBe(false);
  });
});

describe('category seeds', () => {
  it('without a selection seeds every default exactly as before', () => {
    const seeds = categorySeeds(UID, NOW);
    expect(seeds).toHaveLength(DEFAULT_CATEGORIES.length);
    for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
      expect(seeds[index]).toEqual({
        id: defaultCategoryId(UID, category.type, category.name),
        data: { ...category, userId: UID, createdAt: NOW },
      });
    }
  });

  it('seeds only the chosen defaults (same shape) plus the custom ones', () => {
    const selection = (bootstrapSchema.parse({
      categories: {
        defaults: [food, salary],
        custom: [{ type: 'expense', name: 'Coffee', icon: '☕', color: '#A2845E' }, { type: 'income', name: 'Rent', icon: '🏠' }],
      },
    }) as any);
    const seeds = categorySeeds(UID, NOW, selection);
    expect(seeds.map((s) => s.data.name)).toEqual(['Food', 'Salary', 'Coffee', 'Rent']);
    const foodDefault = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!;
    expect(seeds[0]).toEqual({
      id: 'user_1__default__expense_food',
      data: { ...foodDefault, userId: UID, createdAt: NOW },
    });
    expect(seeds[2].data).toEqual({ name: 'Coffee', icon: '☕', color: '#A2845E', type: 'expense', userId: UID, createdAt: NOW });
    // Missing custom color falls back to a calm neutral.
    expect(seeds[3].data.color).toBe('#8E8E93');
  });

  it('derives deterministic custom ids from uid + type + normalized name', () => {
    const id = customCategoryId(UID, 'expense', 'Coffee');
    expect(id).toBe(customCategoryId(UID, 'expense', '  coffee  '));
    expect(id).toBe(customCategoryId(UID, 'expense', 'COFFEE'));
    expect(id).not.toBe(customCategoryId(UID, 'income', 'Coffee'));
    expect(id).not.toBe(customCategoryId('user_2', 'expense', 'Coffee'));
    expect(id).toMatch(/^user_1__onboarding__expense_[0-9a-f]{16}$/);
    // Non-latin names still get distinct ids.
    expect(customCategoryId(UID, 'expense', 'Кофе')).not.toBe(customCategoryId(UID, 'expense', 'Чай'));
    // Never collides with a default id and is not editable-for-free like a default.
    expect(id.startsWith(`${UID}__default__`)).toBe(false);
  });

  it('collapses duplicates and drops a custom entry that repeats a chosen default', () => {
    const selection = (bootstrapSchema.parse({
      categories: {
        defaults: [food, food],
        custom: [
          { type: 'expense', name: 'food', icon: '🍔' },
          { type: 'expense', name: 'Pets', icon: '🐶' },
          { type: 'expense', name: ' pets ', icon: '🐱' },
        ],
      },
    }) as any);
    const seeds = categorySeeds(UID, NOW, selection);
    expect(seeds.map((s) => s.data.name)).toEqual(['Food', 'Pets']);
    expect(seeds[1].data.icon).toBe('🐶');
    // Retrying produces identical ids.
    expect(categorySeeds(UID, NOW + 5, selection).map((s) => s.id)).toEqual(seeds.map((s) => s.id));
  });
});

describe('bootstrap seeding (service)', () => {
  beforeEach(() => {
    db.hasCategories = false;
    db.saved.length = 0;
    db.commits = 0;
  });
  const claims = {} as any;
  const selection = (bootstrapSchema.parse({
    categories: { defaults: [food], custom: [{ type: 'expense', name: 'Coffee', icon: '☕' }] },
  }) as any).categories;

  it('seeds only the selection for a user with no categories', async () => {
    const { bootstrap } = await import('../../src/services/profile.service');
    await bootstrap(UID, claims, { categories: selection });
    expect(db.commits).toBe(1);
    expect(db.saved.map((s) => s.data.name)).toEqual(['Food', 'Coffee']);
    expect(db.saved.every((s) => (s.options as any).merge === true)).toBe(true);
  });

  it('seeds all defaults when no selection is sent', async () => {
    const { bootstrap } = await import('../../src/services/profile.service');
    await bootstrap(UID, claims);
    expect(db.saved).toHaveLength(DEFAULT_CATEGORIES.length);
  });

  it('ignores the selection when the user already has categories', async () => {
    db.hasCategories = true;
    const { bootstrap } = await import('../../src/services/profile.service');
    await bootstrap(UID, claims, { categories: selection });
    expect(db.commits).toBe(0);
    expect(db.saved).toHaveLength(0);
  });

  it('is idempotent: a retry writes the same ids', async () => {
    const { bootstrap } = await import('../../src/services/profile.service');
    await bootstrap(UID, claims, { categories: selection });
    const first = db.saved.map((s) => s.id);
    db.saved.length = 0;
    await bootstrap(UID, claims, { categories: selection });
    expect(db.saved.map((s) => s.id)).toEqual(first);
  });
});

describe('HTTP routes', () => {
  let server: Server;
  let base = '';
  const bootstrapCalls: unknown[][] = [];

  beforeAll(async () => {
    vi.doMock('../../src/services/profile.service', async (importActual) => ({
      ...(await importActual<typeof import('../../src/services/profile.service')>()),
      bootstrap: async (...args: unknown[]) => {
        bootstrapCalls.push(args);
        return { id: UID };
      },
    }));
    const { profileRouter } = await import('../../src/routes/profile.routes');
    const { categoriesRouter } = await import('../../src/routes/categories.routes');
    const { errorHandler } = await import('../../src/middleware/errorHandler');
    const v1 = express.Router();
    v1.use((req, _res, next) => {
      req.uid = UID;
      req.claims = {} as any;
      next();
    });
    v1.use('/profile', profileRouter);
    v1.use('/categories', categoriesRouter);
    const app = express();
    app.use(express.json());
    app.use('/v1', v1);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));
  beforeEach(() => {
    bootstrapCalls.length = 0;
    premium.value = false;
  });

  const post = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  it('passes the validated selection to bootstrap', async () => {
    const response = await post('/profile/bootstrap', {
      categories: { defaults: [food], custom: [{ type: 'expense', name: ' Coffee ', icon: '☕' }] },
      ignored: true,
    });
    expect(response.status).toBe(200);
    expect(bootstrapCalls[0][0]).toBe(UID);
    expect(bootstrapCalls[0][2]).toEqual({
      categories: { defaults: [food], custom: [{ type: 'expense', name: 'Coffee', icon: '☕' }] },
    });
  });

  it('calls bootstrap without a selection for an empty or missing body', async () => {
    expect((await post('/profile/bootstrap')).status).toBe(200);
    expect((await post('/profile/bootstrap', {})).status).toBe(200);
    expect(bootstrapCalls.map((call) => call[2])).toEqual([undefined, undefined]);
  });

  it('rejects an invalid selection with 400 VALIDATION_ERROR and does not bootstrap', async () => {
    const response = await post('/profile/bootstrap', { categories: { defaults: [salary], custom: [] } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(bootstrapCalls).toHaveLength(0);
  });

  it('keeps POST /categories Premium-only for free users', async () => {
    const response = await post('/categories', { name: 'Coffee', icon: '☕', color: '#A2845E', type: 'expense' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PREMIUM_REQUIRED');
  });
});
