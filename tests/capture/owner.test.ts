import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; parameters: readonly unknown[] }>,
  handler: (_sql: string, _parameters: readonly unknown[]): { rows: any[]; numAffectedRows?: bigint } => ({ rows: [] }),
  profile: { exists: true, data: { notifications: { telegram: { chatId: '777' } } } } as any,
  send: vi.fn(),
}));
vi.mock('../../src/db/database', async () => {
  const { Kysely, MysqlDialect } = await import('kysely');
  const dialect = new MysqlDialect({ pool: {} as any });
  const connection = { executeQuery: async (query: any) => {
    const normalized = query.sql.replace(/\s+/g, ' ').trim();
    store.queries.push({ sql: normalized, parameters: query.parameters });
    return store.handler(normalized, query.parameters);
  } };
  const db = new Kysely({ dialect: {
    createAdapter: () => dialect.createAdapter(), createIntrospector: (db: any) => dialect.createIntrospector(db),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createDriver: () => ({ init: async () => {}, acquireConnection: async () => connection,
      beginTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {},
      releaseConnection: async () => {}, destroy: async () => {} }) as any,
  } });
  return { database: () => db, closeDatabase: async () => {} };
});
vi.mock('../../src/db/documents', () => ({ documentKey: (table: string, id: string) => ({ table, id }), readDocument: async () => store.profile }));
vi.mock('../../src/telegram/client', () => ({ sendMessage: store.send }));
import { reviewMerchants, runMerchantSummary } from '../../src/capture/owner';

const monday = new Date('2026-11-02T05:30:00Z'); // 10:30 Tashkent
const merchant = (tin: string, status: string, firstSeen: number) => ({ tin, name: `Synthetic ${tin}`, status, seen_count: 3, first_seen: firstSeen });
const votesFor: Record<string, any[]> = {
  '111111111': [], // brand new, no votes
  '222222222': [{ standard_key: 'food', weight_sum: 4, voter_count: 3 }, { standard_key: 'shopping', weight_sum: 2, voter_count: 2 }], // contested
  '333333333': [{ standard_key: 'food', weight_sum: 5, voter_count: 4 }], // settled
  '444444444': [], // old, unreviewed
};
const rows: Record<string, any> = {
  '111111111': merchant('111111111', 'unknown', monday.getTime() - 86_400_000),
  '222222222': merchant('222222222', 'consensus', 0),
  '333333333': merchant('333333333', 'consensus', 0),
  '444444444': merchant('444444444', 'ai', 0),
};
beforeEach(() => {
  vi.clearAllMocks();
  store.queries = [];
  process.env.DEV_NOTES_UIDS = 'owner-1';
  store.profile = { exists: true, data: { notifications: { telegram: { chatId: '777' } } } };
  store.handler = (query, parameters) => {
    if (query.includes('schema_migrations')) return { rows: [{ version: '005_capture' }] };
    if (query.startsWith('SELECT tin, name, status')) return { rows: Object.values(rows) };
    if (query.includes('FROM merchant_category_votes')) return { rows: votesFor[String(parameters[0])] ?? [] };
    if (query.startsWith('INSERT IGNORE INTO capture_owner_summary')) return { rows: [], numAffectedRows: 1n };
    return { rows: [] };
  };
});

describe('merchant review', () => {
  it('lists new and contested merchants, skipping settled consensus', async () => {
    const result = await reviewMerchants();
    expect(result.map((merchant) => [merchant.tin, merchant.contested])).toEqual([
      ['111111111', false], ['222222222', true], ['444444444', false],
    ]);
  });

  it('limits "new" to the last seven days but always keeps contested ones', async () => {
    const result = await reviewMerchants(30, monday.getTime() - 7 * 86_400_000);
    expect(result.map((merchant) => merchant.tin)).toEqual(['111111111', '222222222']);
  });
});

describe('weekly owner summary', () => {
  it('sends one short message to the owner on Monday 10:00 Tashkent, once per week', async () => {
    await runMerchantSummary(monday);
    expect(store.send).toHaveBeenCalledOnce();
    const [chatId, text, options] = store.send.mock.calls[0];
    expect(chatId).toBe('777');
    expect(text).toContain('2 новых или спорных (спорных: 1)');
    expect(text).toContain('⚠ Synthetic 222222222');
    expect(text).not.toMatch(/voter|uid|owner-1/i);
    expect(options).toEqual({ parse_mode: undefined });
    // The claim row holds only a hash of the owner, never the uid.
    const claim = store.queries.find((query) => query.sql.startsWith('INSERT IGNORE INTO capture_owner_summary'))!;
    expect(claim.parameters).not.toContain('owner-1');
    expect(claim.parameters).toContain('2026-11-02');
  });

  it('does not repeat when this week was already claimed, and stays quiet off-schedule', async () => {
    store.handler = ((inner) => (query: string, parameters: readonly unknown[]) =>
      query.startsWith('INSERT IGNORE INTO capture_owner_summary') ? { rows: [], numAffectedRows: 0n } : inner(query, parameters))(store.handler);
    await runMerchantSummary(monday);
    expect(store.send).not.toHaveBeenCalled();
    await runMerchantSummary(new Date('2026-11-03T05:30:00Z'));
    expect(store.send).not.toHaveBeenCalled();
  });

  it('releases the claim when delivery fails so the next minute retries, without leaking the provider error', async () => {
    store.send.mockRejectedValue(new Error('Telegram says token 000000:SECRET'));
    await expect(runMerchantSummary(monday)).rejects.toThrow('Merchant summary delivery failed');
    expect(store.queries.some((query) => query.sql.startsWith('DELETE FROM capture_owner_summary'))).toBe(true);
  });

  it('sends nothing without an owner, a chat id, or anything to review', async () => {
    process.env.DEV_NOTES_UIDS = '';
    await runMerchantSummary(monday);
    process.env.DEV_NOTES_UIDS = 'owner-1';
    store.profile = { exists: true, data: {} };
    await runMerchantSummary(monday);
    store.profile = { exists: true, data: { notifications: { telegram: { chatId: '777' } } } };
    rows['111111111'].first_seen = 0; delete rows['222222222']; delete rows['444444444'];
    await runMerchantSummary(monday);
    expect(store.send).not.toHaveBeenCalled();
  });
});
