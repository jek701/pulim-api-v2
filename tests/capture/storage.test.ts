import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category } from '../../src/domain/types';

const store = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; parameters: readonly unknown[] }>,
  handler: (_sql: string, _parameters: readonly unknown[]): { rows: any[]; numAffectedRows?: bigint } => ({ rows: [], numAffectedRows: 1n }),
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
vi.mock('../../src/config/env', () => { throw new Error('Storage and migration must not import application env'); });
vi.mock('../../src/db/documents', () => ({ documentKey: (table: string, id: string) => ({ table, id }), readDocument: vi.fn() }));

import { database } from '../../src/db/database';
import { migrateCapture } from '../../src/capture/migration';
import { IKPU_SEEDS } from '../../src/capture/seeds';
import { cacheReceipt, findReceiptDuplicate, getCaptureUsage, refundCaptureUsage, reserveCaptureUsage, safeCachedReceipt } from '../../src/capture/repository';
import { categoryForStandardKey, consensusCategory, inferCaptureCategory, ikpuWeightedCategory, isStandardCategoryKey, learnCaptureTransaction, learningWeight, standardCategoryKey, voterHash } from '../../src/capture/categories';
import { renderMerchantSummary, summaryWeek, verifyMerchant } from '../../src/capture/owner';

const category = (name = 'Food', icon = '🍔', id = 'u__default__expense_food'): Category => ({
  id, name, icon, type: 'expense', color: '#000', userId: 'u', createdAt: 0,
});
const food = category();
const transport = category('Transport', '🚗', 'u__default__expense_transport');

beforeEach(() => {
  store.queries = [];
  store.handler = (query) => ({ rows: query.includes('schema_migrations') ? [{ version: '005_capture' }] : [], numAffectedRows: 1n });
});

describe('category evidence and privacy', () => {
  it('recognizes stable defaults and the exact Telegram legacy test, excluding personal categories', () => {
    expect(standardCategoryKey({ ...food, name: 'Renamed', icon: 'x' })).toBe('food');
    expect(standardCategoryKey({ ...food, id: 'legacy' })).toBe('food');
    expect(standardCategoryKey(category('Groceries', '🍔', 'custom'))).toBeNull();
    expect(standardCategoryKey(category('Food', '🛒', 'custom'))).toBeNull();
    expect(categoryForStandardKey('transport', [food])).toBeUndefined();
  });
  it('requires three distinct voters for the winning category and at least 70% weight', () => {
    expect(consensusCategory([{ standardKey: 'food', weight: 6, voterCount: 2 }])).toBeNull();
    expect(consensusCategory([{ standardKey: 'food', weight: 7, voterCount: 3 }, { standardKey: 'transport', weight: 3, voterCount: 3 }])).toBe('food');
    expect(consensusCategory([{ standardKey: 'food', weight: 6.99, voterCount: 3 }, { standardKey: 'transport', weight: 3.01, voterCount: 3 }])).toBeNull();
  });
  it('weights item categories by amount and uses the longest prefix; ties stay unclassified', () => {
    const map = [{ prefix: '01', standardKey: 'food' }, { prefix: '01234', standardKey: 'transport' }];
    expect(ikpuWeightedCategory([{ ikpu: '012345678', amount: 20 }, { ikpu: '019999', amount: 10 }], map)).toBe('transport');
    expect(ikpuWeightedCategory([{ ikpu: '012345678', amount: 10 }, { ikpu: '019999', amount: 10 }], map)).toBeNull();
  });
  it('keeps the personalized choice ahead of verified merchants and every other source', async () => {
    const custom = category('Coffee', '☕', 'custom');
    store.handler = (query) => ({ rows: query.includes('merchant_user_category') ? [{ category_id: Buffer.from('custom') }] : [], numAffectedRows: 1n });
    const aiGuess = vi.fn();
    expect(await inferCaptureCategory({ uid: 'u', tin: '123456789', categories: [food, custom], aiGuess })).toEqual({ categoryId: 'custom', confidence: 'high', standardKey: null });
    expect(aiGuess).not.toHaveBeenCalled();
    expect(store.queries).toHaveLength(1);
  });
  it('uses verified then consensus and does not substitute another default when the user lacks it', async () => {
    store.handler = (query) => ({ rows: query.includes('SELECT status') ? [{ status: 'verified', standard_key: 'transport' }] : [] });
    expect(await inferCaptureCategory({ uid: 'u', tin: '123456789', categories: [food] })).toEqual({ categoryId: null, confidence: 'low', standardKey: null });
    store.handler = (query) => ({ rows: query.includes('SELECT standard_key, weight_sum') ? [{ standard_key: 'food', weight_sum: 4, voter_count: 3 }] : [] });
    expect((await inferCaptureCategory({ uid: 'u', tin: '123456789', categories: [food] })).categoryId).toBe(food.id);
  });
  it('uses IKPU before AI; an AI guess is only a low-confidence suggestion of the user\'s own category', async () => {
    store.handler = (query) => ({ rows: query.includes('SELECT prefix') ? [{ prefix: '010', standard_key: 'food' }] : [] });
    const aiGuess = vi.fn(async () => 'transport');
    expect(await inferCaptureCategory({ uid: 'u', categories: [food, transport], items: [{ ikpu: '01012345', amount: 500 }], aiGuess })).toEqual({ categoryId: food.id, confidence: 'medium', standardKey: 'food' });
    expect(aiGuess).not.toHaveBeenCalled();
    expect(await inferCaptureCategory({ uid: 'u', categories: [food], aiGuess: async () => 'food' })).toEqual({ categoryId: food.id, confidence: 'low', standardKey: 'food' });
    expect(await inferCaptureCategory({ uid: 'u', categories: [food], aiGuess: async () => 'transport' })).toEqual({ categoryId: null, confidence: 'low', standardKey: 'transport' });
    expect(await inferCaptureCategory({ uid: 'u', categories: [food], aiGuess: async () => 'not_a_category' })).toEqual({ categoryId: null, confidence: 'low', standardKey: null });
  });
  it('claims unknown IKPU classification before model use and stores only validated standard keys', async () => {
    const classifyIkpu = vi.fn(async () => 'food');
    await inferCaptureCategory({ uid: 'u', categories: [food], items: [{ ikpu: '99999123456789012', amount: 1 }], classifyIkpu });
    expect(classifyIkpu).toHaveBeenCalledWith('99999');
    expect(store.queries.some((query) => query.sql.startsWith('INSERT IGNORE INTO ikpu_category_map'))).toBe(true);
    expect(store.queries.find((query) => query.sql.startsWith('UPDATE ikpu_category_map'))?.parameters).toContain('food');
  });
  it('hashes voters with a salt and never includes raw uid in shared votes', async () => {
    expect(voterHash('buyer', 'synthetic-salt-one')).not.toBe(voterHash('buyer', 'synthetic-salt-two'));
    expect(() => voterHash('buyer', '')).toThrow();
    const previousSalt = process.env.CAPTURE_VOTER_SALT;
    process.env.CAPTURE_VOTER_SALT = 'synthetic-salt-one';
    try {
      await learnCaptureTransaction({ uid: 'buyer', transactionId: 'tx1', categoryId: food.id, suggestedCategoryId: transport.id, merchantTin: '123456789', categories: [food] });
      const sharedQueries = store.queries.filter((query) => /(?:INSERT|UPDATE).*merchant_(?:latest|category)_votes/.test(query.sql));
      expect(sharedQueries.length).toBe(2);
      expect(sharedQueries.flatMap((query) => query.parameters)).not.toContain('buyer');
      expect(sharedQueries.find((query) => query.sql.includes('merchant_latest_votes'))?.parameters).toContain(2);
      expect(learningWeight('same', 'same')).toBe(1);
      expect(learningWeight('changed', 'suggested')).toBe(2);
    } finally {
      if (previousSalt === undefined) delete process.env.CAPTURE_VOTER_SALT;
      else process.env.CAPTURE_VOTER_SALT = previousSalt;
    }
  });
  it('replaces a salted voter’s prior full category and weight without accumulating repeat votes', async () => {
    const previousSalt = process.env.CAPTURE_VOTER_SALT;
    process.env.CAPTURE_VOTER_SALT = 'synthetic-salt-one';
    store.handler = (query) => ({ rows: query.startsWith('SELECT standard_key, weight FROM merchant_latest_votes')
      ? [{ standard_key: 'transport', weight: '2.00' }] : [], numAffectedRows: 1n });
    try {
      await learnCaptureTransaction({ uid: 'buyer', transactionId: 'new-tx', categoryId: food.id, suggestedCategoryId: food.id, merchantTin: '123456789', categories: [food] });
      const subtraction = store.queries.find((query) => query.sql.startsWith('UPDATE merchant_category_votes'))!;
      expect(subtraction.parameters).toEqual([2, '123456789', 'transport']);
      expect(subtraction.sql).toContain('voter_count = GREATEST(voter_count - 1, 0)');
      const replacement = store.queries.find((query) => query.sql.startsWith('INSERT INTO merchant_latest_votes'))!;
      expect(replacement.parameters.slice(2, 4)).toEqual(['food', 1]);
      const custom = category('Coffee', '☕', 'personal');
      store.queries = [];
      await learnCaptureTransaction({ uid: 'buyer', transactionId: 'personal-tx', categoryId: custom.id, merchantTin: '123456789', categories: [custom] });
      expect(store.queries.some((query) => query.sql.startsWith('DELETE FROM merchant_latest_votes'))).toBe(true);
      expect(store.queries.some((query) => query.sql.startsWith('INSERT INTO merchant_category_votes'))).toBe(false);
    } finally {
      if (previousSalt === undefined) delete process.env.CAPTURE_VOTER_SALT;
      else process.env.CAPTURE_VOTER_SALT = previousSalt;
    }
  });
  it('does no learning writes when the transaction marker already exists', async () => {
    store.handler = (query) => ({ rows: [], numAffectedRows: query.startsWith('INSERT IGNORE INTO capture_learning') ? 0n : 1n });
    await learnCaptureTransaction({ uid: 'u', transactionId: 'tx1', categoryId: food.id, merchantTin: '123456789', categories: [food] });
    expect(store.queries.filter((query) => !query.sql.includes('schema_migrations'))).toHaveLength(1);
  });
  it('never creates a shared vote for a personal category', async () => {
    const custom = category('Coffee', '☕', 'personal');
    await learnCaptureTransaction({ uid: 'u', transactionId: 'tx1', categoryId: custom.id, merchantTin: '123456789', categories: [custom] });
    expect(store.queries.some((query) => query.sql.startsWith('INSERT INTO merchant_user_category'))).toBe(true);
    expect(store.queries.some((query) => query.sql.startsWith('INSERT INTO merchant_category_votes'))).toBe(false);
  });
});

describe('quota, duplicates, safe cache, additive migration', () => {
  it('reserves with a conditional atomic update and refunds without going below zero', async () => {
    store.handler = (query) => ({ rows: query.startsWith('SELECT count') ? [{ count: '4' }] : [], numAffectedRows: 1n });
    expect(await getCaptureUsage('u', '2026-11')).toBe(4);
    expect(await reserveCaptureUsage('u', '2026-11', 5)).toBe(true);
    expect(store.queries.find((query) => query.sql.startsWith('UPDATE capture_usage'))?.sql).toContain('AND count < ?');
    store.handler = () => ({ rows: [], numAffectedRows: 0n });
    expect(await reserveCaptureUsage('u', '2026-11', 5)).toBe(false);
    await refundCaptureUsage('u', '2026-11');
    expect(store.queries.at(-1)?.sql).toContain('GREATEST(count - 1, 0)');
  });
  it('scopes receipt lookup to the current user and returns the original date/id', async () => {
    store.handler = (query) => ({ rows: query.includes('FROM transactions') ? [{ id: Buffer.from('saved-id'), data_json: JSON.stringify({ date: Date.UTC(2026, 10, 1) }) }] : [{ version: '005_capture' }] });
    expect(await findReceiptDuplicate('buyer', 'a'.repeat(64))).toEqual({ date: '2026-11-01T00:00:00.000Z', transactionId: 'saved-id' });
    expect(store.queries.at(-1)?.parameters).toEqual(['buyer', 'a'.repeat(64)]);
  });
  it('caches only receipt allowlisted fields, redacts identifier-like text, and expires after 30 days', async () => {
    const unsafe = { kind: 'soliq', receiptKey: 'a'.repeat(64), date: '2026-11-01T00:00:00.000Z', total: 100,
      merchant: { tin: '123456789', name: 'Store +998 90 123 45 67', address: 'City', buyer: 'secret' },
      extraInfo: { phoneNumber: 'secret' }, buyer: 'secret', cardNumber: 'secret',
      items: [{ name: 'Milk 8600 1234 5678 9012', quantity: 1, price: 100, amount: 100, discount: 0, ikpu: '010123', buyer: 'secret', categoryId: 'private-category' }] };
    const encoded = JSON.stringify(safeCachedReceipt(unsafe));
    expect(encoded).not.toContain('secret');
    expect(encoded).not.toContain('private-category');
    expect(encoded).not.toContain('8600');
    expect(encoded).toContain('123456789');
    const before = Date.now();
    await cacheReceipt('a'.repeat(64), unsafe);
    const insert = store.queries.find((query) => query.sql.startsWith('INSERT INTO capture_receipt_cache'))!;
    expect(Number(insert.parameters[2]) - before).toBeGreaterThanOrEqual(30 * 86400000);
    expect(store.queries.at(-1)?.sql).toContain('DELETE FROM capture_receipt_cache');
  });
  it('keeps only a literal true refund marker in the cached receipt', () => {
    expect(safeCachedReceipt({ isRefund: true, total: 1 })).toMatchObject({ isRefund: true });
    expect(safeCachedReceipt({ isRefund: 'yes', total: 1 })).not.toHaveProperty('isRefund');
  });
  it('creates additive tables and a generated owner/receipt projection, and seeds valid defaults', async () => {
    await migrateCapture(database());
    expect(store.queries.filter((query) => query.sql.startsWith('CREATE TABLE IF NOT EXISTS'))).toHaveLength(9);
    const ddl = store.queries.map((query) => query.sql).join('\n');
    expect(ddl).toContain('GENERATED ALWAYS AS');
    expect(ddl).toContain(') VIRTUAL');
    expect(ddl).not.toMatch(/STORED/);
    expect(ddl).toContain('user_id(512), capture_receipt_key');
    expect(ddl).not.toMatch(/DROP |TRUNCATE /);
    expect(new Set(IKPU_SEEDS.map((seed) => seed.prefix)).size).toBe(IKPU_SEEDS.length);
    expect(IKPU_SEEDS.every((seed) => /^\d{1,17}$/.test(seed.prefix) && isStandardCategoryKey(seed.standardKey))).toBe(true);
    const classify = (code: string) => ikpuWeightedCategory([{ ikpu: code, amount: 1 }], IKPU_SEEDS);
    expect(classify('03004001001000000')).toBe('health');
    expect(classify('02710001001000000')).toBe('transport');
    expect(classify('10202001001000000')).toBe('food');
    expect(classify('10304001001000000')).toBe('bills');
    expect(classify('03402001001000000')).toBe('shopping');
    expect(classify('08517001001000000')).toBe('shopping');
    expect(classify('02105001001000000')).toBe('food');
    expect(classify('10701001001000000')).toBeNull();

  });
});

describe('owner review', () => {
  it('validates TIN and default key before writing', async () => {
    await expect(verifyMerchant('123', 'food')).rejects.toThrow();
    await expect(verifyMerchant('123456789', 'custom')).rejects.toThrow();
    expect(store.queries).toHaveLength(0);
    await verifyMerchant('123456789', 'food');
    expect(store.queries[0].parameters).toContain('food');
  });
  it('runs only Monday 10 in Tashkent and produces a short content-free review summary', () => {
    expect(summaryWeek(new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02');
    expect(summaryWeek(new Date('2026-11-02T04:59:00Z'))).toBeNull();
    expect(summaryWeek(new Date('2026-11-03T05:00:00Z'))).toBeNull();
    expect(renderMerchantSummary([{ tin: '123456789', name: '<Store>', status: 'unknown', seen_count: 1, first_seen: 0, contested: false, votes: [] }])).toContain('Store · 123456789');
  });
});


describe('readiness rollout', () => {
  it('caches a missing migration and never attempts a receipt projection query', async () => {
    vi.resetModules();
    const fresh = await import('../../src/capture/repository');
    store.handler = () => { throw new Error('synthetic missing schema'); };
    expect(await fresh.isCaptureStorageReady()).toBe(false);
    expect(await fresh.isCaptureStorageReady()).toBe(false);
    expect(await fresh.findReceiptDuplicate('u', 'a'.repeat(64))).toBeUndefined();
    expect(store.queries).toHaveLength(1);
  });
});
