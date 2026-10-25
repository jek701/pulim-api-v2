import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { database, closeDatabase } from '../../src/db/database';
import { migrateDatabase } from '../../src/db/migrate';
import {
  documentKey,
  insertDocument,
  patchDocument,
  patchValue,
  readDocument,
  removeDocument,
  runSqlTransaction,
  saveDocument,
} from '../../src/db/documents';
import { tables } from '../../src/db/tables';
import { initOfflineSync, pruneSyncTombstones } from '../../src/db/syncIndex';

vi.mock('../../src/notifications/queue.repository', () => ({
  scheduleBudgetCheck: async () => {},
  queueTrialStarted: async () => {},
}));
vi.mock('../../src/config/env', () => ({
  isProd: true,
  env: {
    LOG_LEVEL: 'silent',
    NOTIFY_DIGEST_HOUR: 10,
    NOTIFY_TIMEZONE: 'Asia/Tashkent',
    TELEGRAM_BOT_USERNAME: 'local_test_bot',
    WEB_APP_URL: 'https://example.invalid',
    NOTIFY_STALE_AFTER_MS: 21600000,
    NOTIFY_LEASE_MS: 120000,
    PULIM_PAYMENT_INTERNAL_SECRET: 'local-integration-secret-not-production',
  },
}));
const enabled = process.env.PULIM_MYSQL_TESTS === 'true';
const key = (table: keyof typeof tables, id: string) => documentKey(table, id);
const newUid = () => `sync-${randomUUID()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cardDoc = (uid: string, balance = 1000, extra: Record<string, unknown> = {}) => ({
  userId: uid,
  name: 'Card',
  cardType: 'debit',
  currency: 'UZS',
  balance,
  createdAt: 1,
  ...extra,
});

type Doc = Record<string, any>;
type Page = {
  mode: string;
  cursor: string;
  hasMore: boolean;
  collections: Record<string, { upserted: Doc[]; deleted: string[] }>;
};

describe.skipIf(!enabled)('offline sync: change feed + idempotency (real MySQL)', () => {
  let server: import('node:http').Server;
  let base = '';

  beforeAll(async () => {
    if (
      process.env.MYSQL_HOST !== '127.0.0.1' ||
      process.env.MYSQL_PORT !== '3308' ||
      process.env.MYSQL_DATABASE !== 'pulim_app_rehearsal'
    )
      throw new Error('Tests require isolated local rehearsal DB');
    await migrateDatabase();
    for (const table of [...Object.values(tables), 'household_members', 'sync_state', 'sync_entries'])
      await database().deleteFrom(table).execute();
    expect(await initOfflineSync(database())).toBe(true);

    const { idempotency } = await import('../../src/middleware/idempotency');
    const { errorHandler } = await import('../../src/middleware/errorHandler');
    const { transactionsRouter } = await import('../../src/routes/transactions.routes');
    const { cardsRouter } = await import('../../src/routes/cards.routes');
    const { categoriesRouter } = await import('../../src/routes/categories.routes');
    const { savingsGoalsRouter } = await import('../../src/routes/savingsGoals.routes');
    const { subscriptionsRouter } = await import('../../src/routes/subscriptions.routes');
    const { debtsRouter } = await import('../../src/routes/debts.routes');
    const { depositsRouter } = await import('../../src/routes/deposits.routes');
    const { plannedExpensesRouter } = await import('../../src/routes/plannedExpenses.routes');
    const { syncRouter } = await import('../../src/routes/sync.routes');
    const { createTransaction } = await import('../../src/services/transaction.service');
    const { asyncHandler } = await import('../../src/utils/asyncHandler');

    const v1 = Router();
    v1.use((req, _res, next) => {
      req.uid = String(req.headers['x-test-uid']);
      next();
    });
    v1.use(idempotency);
    v1.use('/transactions', transactionsRouter);
    v1.use('/cards', cardsRouter);
    v1.use('/categories', categoriesRouter);
    v1.use('/savings-goals', savingsGoalsRouter);
    v1.use('/subscriptions', subscriptionsRouter);
    v1.use('/debts', debtsRouter);
    v1.use('/deposits', depositsRouter);
    v1.use('/planned-expenses', plannedExpensesRouter);
    v1.use('/sync', syncRouter);
    // Effect commits, then the handler fails: models a crash before the response is stored.
    v1.post(
      '/boom',
      asyncHandler(async (req, _res) => {
        await createTransaction(req.uid, req.body);
        throw new Error('boom after commit');
      }),
    );
    const app = express();
    app.use(express.json());
    app.use('/v1', v1);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  }, 60000);
  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await closeDatabase();
  });

  async function call(
    uid: string,
    method: string,
    path: string,
    body?: unknown,
    idemKey?: string,
  ): Promise<{ status: number; body: any; replayed: boolean }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-test-uid': uid,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      replayed: response.headers.get('idempotent-replayed') === 'true',
    };
  }
  const premium = (uid: string) =>
    insertDocument(key('profiles', uid), {
      isPremium: true,
      subscription: { tier: 'premium', premiumUntil: Date.now() + 86_400_000 * 30 },
    });
  const balanceOf = async (id: string) => (await readDocument(key('cards', id))).data.balance;
  const txCount = async (uid: string) =>
    (await call(uid, 'GET', '/sync/changes?limit=500')).body.collections.transactions?.upserted
      .length ?? 0;

  /** Minimal model of the mobile client: apply pages to a local map until drained. */
  class LocalReplica {
    rows = new Map<string, Doc>(); // `${collection}/${id}`
    cursor: string | undefined;
    cursors: string[] = [];
    constructor(readonly uid: string) {}
    async pull(limit = 50): Promise<Page[]> {
      const pages: Page[] = [];
      for (;;) {
        const query = new URLSearchParams({ limit: String(limit) });
        if (this.cursor) query.set('cursor', this.cursor);
        const response = await call(this.uid, 'GET', `/sync/changes?${query}`);
        if (response.status !== 200) throw Object.assign(new Error('pull failed'), response);
        const page = response.body as Page;
        for (const [collection, change] of Object.entries(page.collections)) {
          for (const doc of change.upserted) this.rows.set(`${collection}/${doc.id}`, doc);
          for (const id of change.deleted) this.rows.delete(`${collection}/${id}`);
        }
        this.cursor = page.cursor;
        this.cursors.push(page.cursor);
        pages.push(page);
        if (!page.hasMore) return pages;
      }
    }
    get(collection: string, id: string) {
      return this.rows.get(`${collection}/${id}`);
    }
  }

  describe('change feed', () => {
    it('streams creates, balance bumps and deletes (tombstones) for every write path', async () => {
      const uid = newUid();
      const replica = new LocalReplica(uid);
      const first = await replica.pull();
      expect(first[0].mode).toBe('snapshot');
      expect(first.at(-1)!.hasMore).toBe(false);

      await insertDocument(key('cards', 'c1'), cardDoc(uid));
      await insertDocument(key('cards', 'c2'), cardDoc(uid, 500));
      await insertDocument(key('categories', 'cat1'), { userId: uid, name: 'Food', createdAt: 1 });
      const second = await replica.pull();
      expect(second[0].mode).toBe('delta');
      expect(replica.get('cards', 'c1')?.balance).toBe(1000);

      const money = await import('../../src/services/transaction.service');
      const transfer = await money.transfer(uid, { fromCardId: 'c1', toCardId: 'c2', amount: 100 });
      await replica.pull();
      expect(replica.get('cards', 'c1')?.balance).toBe(900);
      expect(replica.get('cards', 'c2')?.balance).toBe(600);
      expect(replica.get('transactions', transfer.id)).toBeTruthy();

      // Delete: transfer reverses both legs and leaves a tombstone.
      await money.deleteTransaction(uid, transfer.id);
      await replica.pull();
      expect(replica.get('transactions', transfer.id)).toBeUndefined();
      expect(replica.get('cards', 'c1')?.balance).toBe(1000);
      expect(replica.get('cards', 'c2')?.balance).toBe(500);
    });

    it('cascade delete of a refunded purchase tombstones the refunds too', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      const money = await import('../../src/services/transaction.service');
      const purchase = await money.createTransaction(uid, {
        type: 'expense',
        amount: 200,
        currency: 'UZS',
        categoryId: 'x',
        cardId: `${uid}-c`,
        date: Date.now(),
      });
      const refund = await money.returnTransaction(uid, purchase.id, {
        returnAmount: 50,
        accountId: `${uid}-c`,
      });
      const replica = new LocalReplica(uid);
      await replica.pull();
      expect(replica.get('transactions', refund.id)).toBeTruthy();
      expect(replica.get('transactions', purchase.id)?.returnedAmount).toBe(50);
      await money.deleteTransaction(uid, purchase.id);
      await replica.pull();
      expect(replica.get('transactions', purchase.id)).toBeUndefined();
      expect(replica.get('transactions', refund.id)).toBeUndefined();
      expect(replica.get('cards', `${uid}-c`)?.balance).toBe(1000);
    });

    it('clear-all produces tombstones for each personal transaction', async () => {
      const uid = newUid();
      for (let i = 0; i < 5; i++)
        await insertDocument(key('transactions', `${uid}-t${i}`), {
          userId: uid,
          type: 'expense',
          amount: 1,
          currency: 'UZS',
          categoryId: 'x',
          date: i,
          createdAt: i,
        });
      const replica = new LocalReplica(uid);
      await replica.pull();
      expect([...replica.rows.keys()].filter((k) => k.startsWith('transactions/'))).toHaveLength(5);
      const money = await import('../../src/services/transaction.service');
      expect((await money.clearAllTransactions(uid)).deleted).toBe(5);
      await replica.pull();
      expect([...replica.rows.keys()].filter((k) => k.startsWith('transactions/'))).toHaveLength(0);
    });

    it('pages the snapshot, keeps changes made while paging, and never leaks other users or household rows', async () => {
      const uid = newUid();
      const other = newUid();
      for (let i = 0; i < 12; i++) await insertDocument(key('cards', `${uid}-c${i}`), cardDoc(uid));
      await insertDocument(key('cards', `${other}-c`), cardDoc(other));
      await insertDocument(key('cards', `${uid}-household`), {
        ...cardDoc(`household:${uid}`),
        scope: 'household',
        householdId: uid,
      });
      await insertDocument(key('profiles', uid), { name: 'Me', isPremium: false });
      const replica = new LocalReplica(uid);
      const query = async (cursor?: string) =>
        (await call(uid, 'GET', `/sync/changes?limit=5${cursor ? `&cursor=${cursor}` : ''}`))
          .body as Page;
      let page = await query();
      expect(page.mode).toBe('snapshot');
      expect(page.hasMore).toBe(true);
      // A write lands between snapshot pages.
      await patchDocument(key('cards', `${uid}-c0`), { balance: 4242 });
      await insertDocument(key('cards', `${uid}-late`), cardDoc(uid, 7));
      const seen: Page[] = [page];
      while (page.hasMore) {
        page = await query(page.cursor);
        seen.push(page);
      }
      for (const p of seen)
        for (const [collection, change] of Object.entries(p.collections)) {
          for (const doc of change.upserted) replica.rows.set(`${collection}/${doc.id}`, doc);
        }
      replica.cursor = page.cursor;
      expect(page.mode).toBe('snapshot');
      await replica.pull();
      expect(replica.get('cards', `${uid}-c0`)?.balance).toBe(4242);
      expect(replica.get('cards', `${uid}-late`)).toBeTruthy();
      expect(replica.get('profile', uid)?.name).toBe('Me');
      expect([...replica.rows.keys()].some((k) => k.includes(other))).toBe(false);
      expect(replica.get('cards', `${uid}-household`)).toBeUndefined();
      expect([...replica.rows.keys()].filter((k) => k.startsWith('cards/'))).toHaveLength(13);
    });

    it('delivers Telegram-style idempotent writes that interleave with pulls, exactly once', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      await insertDocument(key('categories', `${uid}-cat`), { userId: uid, name: 'Food', createdAt: 1 });
      const money = await import('../../src/services/transaction.service');
      const replica = new LocalReplica(uid);
      await replica.pull();
      const input = {
        type: 'expense',
        amount: 10,
        currency: 'UZS',
        categoryId: `${uid}-cat`,
        cardId: `${uid}-c`,
        date: Date.now(),
      };
      const results = await Promise.all([
        ...Array.from({ length: 5 }, () => money.createTelegramTransactionOnce(uid, input, 'op-1')),
        replica.pull(),
        replica.pull(),
      ]);
      expect(results.slice(0, 5).filter((r: any) => r.created)).toHaveLength(1);
      await replica.pull();
      expect(replica.get('cards', `${uid}-c`)?.balance).toBe(990);
      expect([...replica.rows.keys()].filter((k) => k.startsWith('transactions/'))).toHaveLength(1);
      // Telegram-origin docs carry origin, never an id field.
      const tx = [...replica.rows.values()].find((d) => d.origin === 'telegram')!;
      expect(tx).toBeTruthy();
    });

    it('never skips a change when writers commit concurrently with a polling reader (commit-order sequence)', async () => {
      const uid = newUid();
      const ids = Array.from({ length: 24 }, (_, i) => `${uid}-card-${i}`);
      for (const id of ids) await insertDocument(key('cards', id), cardDoc(uid, 0));
      const replica = new LocalReplica(uid);
      await replica.pull();
      let writing = true;
      const poller = (async () => {
        while (writing) {
          await replica.pull(7);
          await sleep(3);
        }
      })();
      const writers = ids.flatMap((id, index) =>
        [1, 2, 3].map(async () => {
          await sleep(Math.random() * 30);
          await runSqlTransaction(async (tx) => {
            const doc = await tx.read(key('cards', id));
            await sleep(Math.random() * 25);
            tx.patch(doc.key, { balance: patchValue.increment(index + 1) });
          });
        }),
      );
      await Promise.all(writers);
      writing = false;
      await poller;
      await replica.pull(7);
      for (const [index, id] of ids.entries()) {
        expect(replica.get('cards', id)?.balance).toBe((index + 1) * 3);
        expect(await balanceOf(id)).toBe((index + 1) * 3);
      }
      // Delta cursors only move forward.
      const seqs = replica.cursors.filter((c) => c.startsWith('d1.')).map((c) => Number(c.split('.')[2]));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }, 30000);

    it('answers 410 for a cursor behind pruned tombstones and 400 for a malformed one', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      const replica = new LocalReplica(uid);
      await replica.pull();
      const stale = replica.cursor!;
      await removeDocument(key('cards', `${uid}-c`));
      await insertDocument(key('cards', `${uid}-d`), cardDoc(uid));
      expect(await pruneSyncTombstones(database(), 0, Date.now() + 1000)).toBeGreaterThanOrEqual(1);
      const expired = await call(uid, 'GET', `/sync/changes?cursor=${stale}`);
      expect(expired.status).toBe(410);
      expect(expired.body.error.code).toBe('CURSOR_EXPIRED');
      expect((await call(uid, 'GET', '/sync/changes?cursor=garbage')).status).toBe(400);
      expect((await call(uid, 'GET', '/sync/changes?cursor=d1.1.999999999')).status).toBe(410);
      // A fresh snapshot recovers.
      const fresh = new LocalReplica(uid);
      await fresh.pull();
      expect(fresh.get('cards', `${uid}-d`)).toBeTruthy();
      expect(fresh.get('cards', `${uid}-c`)).toBeUndefined();
    });

    it('reports capabilities', async () => {
      const response = await call(newUid(), 'GET', '/sync/capabilities');
      expect(response.body).toMatchObject({ contract: 1, offlineSync: true });
    });
  });

  describe('Idempotency-Key', () => {
    const txBody = (cardId: string, extra: Record<string, unknown> = {}) => ({
      type: 'expense',
      amount: 100,
      currency: 'UZS',
      categoryId: 'food',
      cardId,
      date: 1_700_000_000_000,
      ...extra,
    });

    it('replays the original response without a second balance effect', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      const k = randomUUID();
      const first = await call(uid, 'POST', '/transactions', txBody(`${uid}-c`), k);
      const second = await call(uid, 'POST', '/transactions', txBody(`${uid}-c`), k);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.replayed).toBe(true);
      expect(first.replayed).toBe(false);
      expect(second.body).toEqual(first.body);
      expect(await balanceOf(`${uid}-c`)).toBe(900);
      expect(await txCount(uid)).toBe(1);
    });

    it('is exactly-once under concurrent double-submit of the same key', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      const k = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => call(uid, 'POST', '/transactions', txBody(`${uid}-c`), k)),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await balanceOf(`${uid}-c`)).toBe(900);
      expect(await txCount(uid)).toBe(1);
    });

    it('rejects a reused key with a different body (422) and does not apply it', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      const k = randomUUID();
      await call(uid, 'POST', '/transactions', txBody(`${uid}-c`), k);
      const other = await call(uid, 'POST', '/transactions', txBody(`${uid}-c`, { amount: 5 }), k);
      expect(other.status).toBe(422);
      expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(`${uid}-c`)).toBe(900);
    });

    it('scopes keys per user and validates the key format', async () => {
      const a = newUid();
      const b = newUid();
      await insertDocument(key('cards', `${a}-c`), cardDoc(a));
      await insertDocument(key('cards', `${b}-c`), cardDoc(b));
      const k = randomUUID();
      expect((await call(a, 'POST', '/transactions', txBody(`${a}-c`), k)).status).toBe(201);
      const forB = await call(b, 'POST', '/transactions', txBody(`${b}-c`), k);
      expect(forB.status).toBe(201);
      expect(forB.replayed).toBe(false);
      expect(await balanceOf(`${b}-c`)).toBe(900);
      const bad = await call(a, 'POST', '/transactions', txBody(`${a}-c`), 'short');
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('does not store failures, so a later retry can succeed', async () => {
      const uid = newUid();
      const k = randomUUID();
      const body = txBody(`${uid}-late-card`);
      expect((await call(uid, 'POST', '/transactions', body, k)).status).toBe(404);
      await insertDocument(key('cards', `${uid}-late-card`), cardDoc(uid));
      const retry = await call(uid, 'POST', '/transactions', body, k);
      expect(retry.status).toBe(201);
      expect(retry.replayed).toBe(false);
      expect(await balanceOf(`${uid}-late-card`)).toBe(900);
    });

    it('old clients without the header keep today\'s behaviour (no dedupe, no side tables)', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      await call(uid, 'POST', '/transactions', txBody(`${uid}-c`));
      await call(uid, 'POST', '/transactions', txBody(`${uid}-c`));
      expect(await balanceOf(`${uid}-c`)).toBe(800);
      const markers = await database()
        .selectFrom('idempotency_keys')
        .select(database().fn.countAll().as('n'))
        .where('user_id', '=', Buffer.from(uid))
        .executeTakeFirstOrThrow();
      expect(Number(markers.n)).toBe(0);
    });

    it('covers operation endpoints: transfer, return, debt, subscription pay, savings, deposit', async () => {
      const uid = newUid();
      await premium(uid);
      await insertDocument(key('cards', `${uid}-a`), cardDoc(uid, 1000));
      await insertDocument(key('cards', `${uid}-b`), cardDoc(uid, 100));
      const twice = async (method: string, path: string, body?: unknown) => {
        const k = randomUUID();
        const one = await call(uid, method, path, body, k);
        const two = await call(uid, method, path, body, k);
        expect(one.status).toBeLessThan(300);
        expect(two.status).toBe(one.status);
        expect(two.replayed).toBe(true);
        expect(two.body).toEqual(one.body);
        return one;
      };
      const transfer = await twice('POST', '/transactions/transfer', {
        fromCardId: `${uid}-a`,
        toCardId: `${uid}-b`,
        amount: 100,
      });
      expect(await balanceOf(`${uid}-a`)).toBe(900);
      expect(await balanceOf(`${uid}-b`)).toBe(200);

      const purchase = await call(uid, 'POST', '/transactions', txBody(`${uid}-a`, { amount: 300 }));
      expect(await balanceOf(`${uid}-a`)).toBe(600);
      await twice('POST', `/transactions/${purchase.body.id}/return`, {
        returnAmount: 40,
        accountId: `${uid}-a`,
      });
      expect(await balanceOf(`${uid}-a`)).toBe(640);

      await twice('PATCH', `/transactions/${transfer.body.id}/transfer`, {
        fromCardId: `${uid}-a`,
        toCardId: `${uid}-b`,
        amount: 150,
        date: Date.now(),
      });
      expect(await balanceOf(`${uid}-a`)).toBe(590);
      expect(await balanceOf(`${uid}-b`)).toBe(250);

      await twice('POST', '/debts', {
        direction: 'owe_me',
        person: 'Ali',
        amount: 50,
        currency: 'UZS',
        accountId: `${uid}-a`,
      });
      expect(await balanceOf(`${uid}-a`)).toBe(540);

      await insertDocument(key('subscriptions', `${uid}-sub`), {
        userId: uid,
        name: 'Music',
        icon: 'x',
        amount: 20,
        currency: 'UZS',
        cycle: 'monthly',
        nextBillingDate: Date.now(),
        isActive: true,
        createdAt: 1,
      });
      await twice('POST', `/subscriptions/${uid}-sub/pay`, { accountId: `${uid}-a` });
      expect(await balanceOf(`${uid}-a`)).toBe(520);

      await insertDocument(key('savingsGoals', `${uid}-goal`), {
        userId: uid,
        name: 'Trip',
        icon: 'x',
        targetAmount: 1000,
        savedAmount: 0,
        currency: 'UZS',
        deadline: 1,
        createdAt: 1,
      });
      await twice('POST', `/savings-goals/${uid}-goal/contribute`, {
        amount: 30,
        accountId: `${uid}-a`,
      });
      expect(await balanceOf(`${uid}-a`)).toBe(490);
      expect((await readDocument(key('savingsGoals', `${uid}-goal`))).data.savedAmount).toBe(30);

      await insertDocument(key('deposits', `${uid}-dep`), {
        userId: uid,
        bank: 'B',
        amount: 100,
        currency: 'UZS',
        interestRate: 0,
        startDate: Date.now(),
        endDate: Date.now() + 86400000,
        capitalization: 'at_end',
        interestPaidOut: 0,
        isReplenishable: true,
        isClosed: false,
      });
      await twice('POST', `/deposits/${uid}-dep/replenish`, { accountId: `${uid}-a`, amount: 10 });
      expect(await balanceOf(`${uid}-a`)).toBe(480);

      await twice('DELETE', `/transactions/${purchase.body.id}`);
      // purchase 300 returned +40: deleting reverses the refund (-40) and the purchase (+300).
      expect(await balanceOf(`${uid}-a`)).toBe(480 + 300 - 40);
    });

    it('replays the effect when the process failed after commit but before storing the response', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      const k = randomUUID();
      const body = txBody(`${uid}-c`);
      const crashed = await call(uid, 'POST', '/boom', body, k);
      expect(crashed.status).toBe(500);
      expect(await balanceOf(`${uid}-c`)).toBe(900);
      const retry = await call(uid, 'POST', '/boom', body, k);
      expect(retry.replayed).toBe(true);
      expect(retry.status).toBe(201);
      expect(retry.body).toMatchObject({ amount: 100, cardId: `${uid}-c` });
      expect(await balanceOf(`${uid}-c`)).toBe(900);
      expect(await txCount(uid)).toBe(1);
    }, 15000);

    it('treats an expired marker as free and lets the key be used again', async () => {
      const uid = newUid();
      await insertDocument(key('cards', `${uid}-c`), cardDoc(uid));
      const k = randomUUID();
      await call(uid, 'POST', '/transactions', txBody(`${uid}-c`), k);
      await database()
        .updateTable('idempotency_keys')
        .set({ expires_at_ms: 1 })
        .where('user_id', '=', Buffer.from(uid))
        .execute();
      // The stored expiry lives in the document too.
      const { markerIdFor } = await import('../../src/middleware/idempotency');
      const { Timestamp } = await import('../../src/db/documents');
      await saveDocument(
        key('idempotencyKeys', markerIdFor(uid, k)),
        { expiresAt: Timestamp.fromMillis(1) },
        { merge: true },
      );
      const again = await call(uid, 'POST', '/transactions', txBody(`${uid}-c`), k);
      expect(again.status).toBe(201);
      expect(again.replayed).toBe(false);
      expect(await balanceOf(`${uid}-c`)).toBe(800);
    });
  });
});
