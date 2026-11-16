import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  rows: [] as any[],
  queries: [] as any[],
  fixtures: {} as Record<string, any[]>,
}));
vi.mock('../../src/db/database', () => ({
  database: () => ({
    selectFrom: (table: string) => {
      const query: any = { table, filters: [], fields: [] };
      state.queries.push(query);
      const chain: any = {
        select: (fields: any) => {
          query.fields = fields;
          return chain;
        },
        where: (...args: any[]) => {
          query.filters.push(args);
          return chain;
        },
        orderBy: () => chain,
        groupBy: () => chain,
        limit: (limit: number) => {
          query.limit = limit;
          return chain;
        },
        execute: async () => {
          if (table !== 'profiles') return state.fixtures[table] ?? [];
          let rows = state.rows;
          for (const [field, op, value] of query.filters)
            if (field === 'id')
              rows = rows.filter((row) =>
                op === '>'
                  ? Buffer.compare(row.id, value) > 0
                  : value.some((id: Buffer) => id.equals(row.id)),
              );
          return rows.slice(0, query.limit ?? rows.length);
        },
      };
      return chain;
    },
  }),
}));
import {
  listCrmUsers,
  getCrmFacts,
  userFacts,
  registeredProfile,
  encodeCrmCursor,
} from '../../src/crm/facts';
const profile = (extra: any = {}) => ({
  linkedAuthMethods: ['apple'],
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const row = (id: string, data = profile()) => ({
  id: Buffer.from(id),
  data_json: data,
  types_json: {},
});
beforeEach(() => {
  state.rows = [];
  state.queries = [];
  state.fixtures = {};
});
describe('anonymous CRM facts boundary', () => {
  it('only returns the exact frozen fact fields, never profile or consent free text', () => {
    const facts = userFacts(
      'uid',
      profile({
        name: 'PRIVATE',
        phoneNumberMasked: 'PRIVATE',
        email: 'PRIVATE',
        telegramChatIds: [12345],
        consents: { ai: { version: 'PRIVATE' } },
        isPremium: true,
        subscription: { premiumUntil: 1000, isTrial: true, trialGrantedAt: 1 },
      }),
      { counts: { accounts: 4 }, hasPushDevice: true, appVersion: '1.0.0', inHousehold: true },
      10,
    );
    expect(Object.keys(facts).sort()).toEqual(
      [
        'uid',
        'createdAt',
        'updatedAt',
        'language',
        'timezone',
        'tier',
        'premiumUntil',
        'isTrial',
        'trialUsed',
        'hasPushDevice',
        'pushEnabled',
        'marketingPushAllowed',
        'appVersion',
        'telegramLinked',
        'lastTransactionAt',
        'transactions30d',
        'counts',
        'aiMessages30d',
        'captures30d',
        'inHousehold',
      ].sort(),
    );
    expect(Object.keys(facts.counts).sort()).toEqual(
      [
        'accounts',
        'budgets',
        'plans',
        'goals',
        'debts',
        'subscriptions',
        'categoriesCustom',
      ].sort(),
    );
    expect(JSON.stringify(facts)).not.toMatch(/PRIVATE|12345|consents/);
    expect(facts).toMatchObject({
      tier: 'premium',
      isTrial: true,
      trialUsed: true,
      counts: { accounts: 4 },
      hasPushDevice: true,
    });
    expect(userFacts('uid', profile(), { appVersion: 'private free text' }).appVersion).toBe('');
  });
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
    [true, undefined, false],
  ])('marketing permission enabled=%s tips=%s → %s', (enabled, tips, expected) => {
    expect(
      userFacts('uid', profile({ notifications: { enabled, groups: { tips } } }))
        .marketingPushAllowed,
    ).toBe(expected);
  });
  it('requires positive registration evidence and excludes deletion marks', () => {
    expect(registeredProfile(profile())).toBe(true);
    expect(registeredProfile(profile({ deletionRequestedAt: 1 }))).toBe(false);
    expect(registeredProfile({ updatedAt: 1 })).toBe(false);
    expect(registeredProfile({ isTelegramUser: true })).toBe(true);
  });
  it('pages stable binary keys with an opaque cursor and ignores unindexed updatedSince', async () => {
    state.rows = [row('a'), row('b', { updatedAt: 1 }), row('c'), row('d')];
    const first = await listCrmUsers({ limit: 2, updatedSince: 999999 });
    expect(first.users.map((u) => u.uid)).toEqual(['a']);
    expect(first.nextCursor).toBe(encodeCrmCursor('b'));
    const second = await listCrmUsers({ limit: 2, cursor: first.nextCursor! });
    expect(second.users.map((u) => u.uid)).toEqual(['c', 'd']);
    expect(second.nextCursor).toBeNull();
    expect(
      state.queries
        .filter((q) => q.table === 'profiles')
        .flatMap((q) => q.filters)
        .some((f) => f[0] === 'updated_at_ms'),
    ).toBe(false);
    await expect(listCrmUsers({ limit: 2, cursor: 'invalid!' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
  it('unknown, anonymous and deleted facts are absent, batched reads stay constant per page', async () => {
    state.rows = [
      row('a'),
      row('deleted', profile({ deletionRequestedAt: 1 })),
      row('guest', { updatedAt: 1 }),
    ];
    state.fixtures.cards = [{ user_id: Buffer.from('a'), n: '3' }];
    state.fixtures.push_devices = [
      { uid: Buffer.from('a'), app_version: '1.2.3', last_seen_at: 1 },
    ];
    state.fixtures.household_members = [{ user_id: Buffer.from('a') }];
    const result = await getCrmFacts(['a', 'missing', 'deleted', 'guest']);
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({
      uid: 'a',
      counts: { accounts: 3 },
      hasPushDevice: true,
      appVersion: '1.2.3',
      inHousehold: true,
    });
    expect(state.queries).toHaveLength(12);
  });
});
