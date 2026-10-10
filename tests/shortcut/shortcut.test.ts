import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({ collections: new Map<string, Map<string, Row>>() }));

function collection(name: string) {
  if (!store.collections.has(name)) store.collections.set(name, new Map());
  const rows = store.collections.get(name)!;
  const doc = (id: string) => ({
    id,
    get: async () => ({ id, exists: rows.has(id), data: () => rows.get(id) }),
    create: async (data: Row) => {
      if (rows.has(id)) throw new Error('exists');
      rows.set(id, data);
    },
    update: async (data: Row) => rows.set(id, { ...rows.get(id), ...data }),
    ref: { id },
  });
  return {
    doc,
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => {
        const docs = [...rows.entries()].filter(([, row]) => row[field] === value)
          .map(([id, row]) => ({ id, data: () => row, ref: { id, collection: name } }));
        return { empty: docs.length === 0, docs };
      },
    }),
  };
}

vi.mock('../../src/config/firebase', () => ({
  db: {
    collection,
    batch: () => {
      const deletes: Array<{ id: string; collection: string }> = [];
      return {
        delete: (ref: { id: string; collection: string }) => deletes.push(ref),
        commit: async () => deletes.forEach((ref) => store.collections.get(ref.collection)!.delete(ref.id)),
      };
    },
  },
  auth: {},
  Timestamp: {},
  FieldValue: {},
}));

const premium = vi.hoisted(() => ({ value: true }));
const created = vi.hoisted(() => [] as Row[]);
vi.mock('../../src/services/entitlement.service', () => ({ getIsPremium: async () => premium.value }));
vi.mock('../../src/repositories/profile.repository', () => ({ getProfile: async () => ({ language: 'ru' }) }));
vi.mock('../../src/services/fxRates.service', () => ({ getRateToBase: async () => 12_800 }));
vi.mock('../../src/services/transaction.service', () => ({
  createTransaction: async (_uid: string, input: Row) => {
    created.push(input);
    return { id: 'tx1', ...input };
  },
}));

const shortcut = await import('../../src/services/shortcut.service');

function seed() {
  store.collections.clear();
  created.length = 0;
  premium.value = true;
  const cards = collection('cards');
  void cards.doc('humo').create({ userId: 'u1', name: 'Humo', bank: 'Kapital', cardType: 'debit', currency: 'UZS', balance: 500_000, createdAt: 1 });
  void cards.doc('visa').create({ userId: 'u1', name: 'Visa', bank: '', cardType: 'debit', currency: 'USD', balance: 100, createdAt: 2 });
  void cards.doc('other').create({ userId: 'u2', name: 'Not mine', bank: '', cardType: 'debit', currency: 'UZS', balance: 0, createdAt: 3 });
  void collection('userSettings').doc('u1').create({ cardOrder: ['visa', 'humo'] });
  const categories = collection('categories');
  void categories.doc('food').create({ userId: 'u1', name: 'Food', icon: '🍔', type: 'expense', createdAt: 1 });
  void categories.doc('salary').create({ userId: 'u1', name: 'Salary', icon: '💼', type: 'income', createdAt: 2 });
}

describe('shortcut keys', () => {
  beforeEach(seed);

  it('stores only a hash, and the issued key authenticates', async () => {
    const { token, status } = await shortcut.issueShortcutToken('u1');

    expect(token.startsWith('pulim_sc_')).toBe(true);
    expect(status).toMatchObject({ active: true, hint: token.slice(-4) });
    expect([...store.collections.get('shortcutTokens')!.keys()]).not.toContain(token);
    await expect(shortcut.authenticateShortcut(`Bearer ${token}`, 'ru')).resolves.toEqual({ uid: 'u1', language: 'ru' });
  });

  it('a new key disconnects the old one', async () => {
    const first = await shortcut.issueShortcutToken('u1');
    await shortcut.issueShortcutToken('u1');

    await expect(shortcut.authenticateShortcut(`Bearer ${first.token}`, 'ru')).rejects.toMatchObject({ status: 401 });
  });

  it('free users cannot create a key', async () => {
    premium.value = false;
    await expect(shortcut.issueShortcutToken('u1')).rejects.toMatchObject({ code: 'PREMIUM_REQUIRED' });
  });

  it('explains Premium when an existing key belongs to a lapsed subscriber', async () => {
    const { token } = await shortcut.issueShortcutToken('u1');
    premium.value = false;

    await expect(shortcut.authenticateShortcut(`Bearer ${token}`, 'ru'))
      .rejects.toMatchObject({ status: 402, text: expect.stringContaining('Premium') });
  });

  it('rejects malformed keys with a readable message', async () => {
    await expect(shortcut.authenticateShortcut('Bearer nope', 'en'))
      .rejects.toMatchObject({ status: 401, text: expect.stringContaining('Settings') });
  });
});

describe('shortcut expense entry', () => {
  const user = { uid: 'u1', language: 'ru' as const };
  beforeEach(seed);

  it('lists own cards in Accounts order and only expense categories', async () => {
    expect(await shortcut.listShortcutCards(user)).toEqual(['💳 Visa', '💳 Humo · Kapital']);
    expect(await shortcut.listShortcutCategories(user)).toEqual(['🍔 Еда']);
  });

  it('records the expense on the picked card', async () => {
    const reply = await shortcut.addShortcutExpense(user, { amount: '25 000', card: '💳 Humo · Kapital', category: '🍔 Еда' });

    expect(created[0]).toMatchObject({ type: 'expense', amount: 25_000, currency: 'UZS', cardId: 'humo', categoryId: 'food' });
    expect(reply).toContain('✅ Записано');
    expect(reply).toContain('Остаток');
  });

  it('stores the NBU rate for a foreign-currency card so statistics stay in UZS', async () => {
    await shortcut.addShortcutExpense(user, { amount: 10, card: '💳 Visa', category: '🍔 Еда' });

    expect(created[0]).toMatchObject({ currency: 'USD', baseAmount: 128_000, fxRate: 12_800, fxRateSource: 'NBU' });
  });

  it('refuses unknown cards and categories instead of guessing', async () => {
    await expect(shortcut.addShortcutExpense(user, { amount: 1000, card: '💳 Not mine', category: '🍔 Еда' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(shortcut.addShortcutExpense(user, { amount: 1000, card: '💳 Humo · Kapital', category: '💼 Зарплата' }))
      .rejects.toMatchObject({ status: 400 });
    expect(created).toHaveLength(0);
  });

  it.each([['abc'], ['0'], ['-5'], [''], ['1e9']])('rejects amount %s', (value) => {
    expect(shortcut.parseShortcutAmount(value)).toBeNull();
  });

  it.each([['25000', 25_000], ['25 000', 25_000], ['25,000', 25_000], ['1.250.000', 1_250_000], ['12,5', 12.5], ['12.50', 12.5], [42, 42]] as const)('parses amount %s', (value, expected) => {
    expect(shortcut.parseShortcutAmount(value)).toBe(expected);
  });
});
