import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import { database, closeDatabase } from '../../src/db/database';
import { migrateDatabase } from '../../src/db/migrate';
import {
  documentKey,
  filterQuery,
  insertDocument,
  limitQuery,
  orderQuery,
  afterQuery,
  patchDocument,
  patchValue,
  queryTable,
  readDocument,
  runSqlTransaction,
  saveDocument,
} from '../../src/db/documents';
import { tables } from '../../src/db/tables';

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
const card = {
  userId: 'test-user',
  name: 'Card',
  cardType: 'debit',
  currency: 'UZS',
  balance: 1000,
  createdAt: 1,
};

describe.skipIf(!enabled)('MySQL migration integration', () => {
  beforeAll(async () => {
    // Destructive test cleanup is confined to the explicitly named local rehearsal DB.
    if (
      process.env.MYSQL_HOST !== '127.0.0.1' ||
      process.env.MYSQL_PORT !== '3308' ||
      process.env.MYSQL_DATABASE !== 'pulim_app_rehearsal'
    )
      throw new Error('Tests require isolated local rehearsal DB');
    await migrateDatabase();
    for (const table of [
      ...Object.values(tables),
      'household_members',
      'migration_runs',
      'migration_documents',
      'legacy_documents',
    ])
      await database().deleteFrom(table).execute();
  }, 30000);
  afterAll(closeDatabase);

  it('preserves case, trailing spaces, missing/null, and document-ID selection before limit', async () => {
    for (const id of ['A', 'a', 'a ']) await insertDocument(key('userSettings', id), { value: id });
    expect((await readDocument(key('userSettings', 'a '))).data.value).toBe('a ');
    await insertDocument(key('categories', 'a'), { userId: 'u', createdAt: 1, value: null });
    await insertDocument(key('categories', 'b'), { userId: 'u', createdAt: 9 });
    const query = filterQuery(queryTable('categories'), 'userId', '==', 'u');
    expect((await readDocument(limitQuery(query, 1))).rows[0].id).toBe('a');
    expect(
      (await readDocument(filterQuery(query, 'value', '==', null))).rows.map((row) => row.id),
    ).toEqual(['a']);
    const ordered = orderQuery(query, 'createdAt');
    const first = (await readDocument(limitQuery(ordered, 1))).rows[0];
    expect((await readDocument(afterQuery(ordered, first))).rows.map((row) => row.id)).toEqual([
      'b',
    ]);
  });

  it('rolls back all scheduled writes when a later mutation fails', async () => {
    await insertDocument(key('cards', 'rollback'), card);
    await expect(
      runSqlTransaction(async (tx) => {
        tx.patch(key('cards', 'rollback'), { balance: patchValue.increment(-100) });
        tx.patch(key('cards', 'missing'), { balance: 0 });
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect((await readDocument(key('cards', 'rollback'))).data.balance).toBe(1000);
  });

  it('serializes concurrent balance increments without lost updates', async () => {
    await insertDocument(key('cards', 'parallel'), card);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        patchDocument(key('cards', 'parallel'), { balance: patchValue.increment(-10) }),
      ),
    );
    expect((await readDocument(key('cards', 'parallel'))).data.balance).toBe(880);
  });

  it('keeps numeric range queries type-safe and preserves fractional values and implicit ordering', async () => {
    await insertDocument(key('categories', 'z-two'), { userId: 'mixed', createdAt: 2 });
    await insertDocument(key('categories', 'a-fraction'), { userId: 'mixed', createdAt: 3.5 });
    await insertDocument(key('categories', 'string-number'), { userId: 'mixed', createdAt: '4' });
    const query = filterQuery(
      filterQuery(queryTable('categories'), 'userId', '==', 'mixed'),
      'createdAt',
      '>',
      1,
    );
    expect((await readDocument(query)).rows.map((row) => row.id)).toEqual(['z-two', 'a-fraction']);
  });

  it('keeps expense/edit/refund/delete and a two-card transfer atomic', async () => {
    const money = await import('../../src/services/transaction.service');
    await insertDocument(key('cards', 'debit'), card);
    await insertDocument(key('cards', 'credit'), { ...card, cardType: 'credit', balance: 200 });
    const expense = await money.createTransaction('test-user', {
      type: 'expense',
      amount: 100,
      currency: 'UZS',
      cardId: 'debit',
      categoryId: 'food',
      date: 1,
    });
    expect((await readDocument(key('cards', 'debit'))).data.balance).toBe(900);
    await money.updateTransaction('test-user', expense.id, { amount: 150 });
    expect((await readDocument(key('cards', 'debit'))).data.balance).toBe(850);
    const refund = await money.returnTransaction('test-user', expense.id, {
      returnAmount: 40,
      accountId: 'debit',
    });
    expect((await readDocument(key('cards', 'debit'))).data.balance).toBe(890);
    expect((await readDocument(key('transactions', expense.id))).data.returnedAmount).toBe(40);
    await money.deleteTransaction('test-user', refund.id);
    await money.deleteTransaction('test-user', expense.id);
    expect((await readDocument(key('cards', 'debit'))).data.balance).toBe(1000);
    await money.transfer('test-user', { fromCardId: 'debit', toCardId: 'credit', amount: 50 });
    expect((await readDocument(key('cards', 'debit'))).data.balance).toBe(950);
    expect((await readDocument(key('cards', 'credit'))).data.balance).toBe(150);
  });

  it('commits a repeated Telegram operation once under concurrent delivery', async () => {
    const money = await import('../../src/services/transaction.service');
    await insertDocument(key('cards', 'once'), card);
    await insertDocument(key('categories', 'food'), { userId: 'test-user', name: 'Food' });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        money.createTelegramTransactionOnce(
          'test-user',
          {
            type: 'expense',
            amount: 100,
            currency: 'UZS',
            cardId: 'once',
            categoryId: 'food',
            date: 1,
          },
          'same-update',
        ),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await readDocument(key('cards', 'once'))).data.balance).toBe(900);
    expect(new Set(results.map((result) => result.transaction.id)).size).toBe(1);
  });

  it('retries opposing transfers without partial commits or a change in total balance', async () => {
    const money = await import('../../src/services/transaction.service');
    await insertDocument(key('cards', 'opposite-A'), card);
    await insertDocument(key('cards', 'opposite-B'), card);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        money.transfer('test-user', {
          fromCardId: i % 2 ? 'opposite-A' : 'opposite-B',
          toCardId: i % 2 ? 'opposite-B' : 'opposite-A',
          amount: 10,
        }),
      ),
    );
    expect((await readDocument(key('cards', 'opposite-A'))).data.balance).toBe(1000);
    expect((await readDocument(key('cards', 'opposite-B'))).data.balance).toBe(1000);
  });

  it('preserves debt, savings and subscription money movements', async () => {
    const debt = await import('../../src/services/debt.service');
    const savings = await import('../../src/services/savings.service');
    const subscriptions = await import('../../src/services/subscription.service');
    await insertDocument(key('cards', 'composite'), { ...card, balance: 2000 });
    const borrowed = await debt.createDebt('test-user', {
      direction: 'i_owe',
      person: 'Synthetic',
      amount: 300,
      currency: 'UZS',
      accountId: 'composite',
    });
    expect((await readDocument(key('cards', 'composite'))).data.balance).toBe(2300);
    await debt.payDebt('test-user', borrowed.id, 100, 'composite');
    expect((await readDocument(key('debts', borrowed.id))).data.paidAmount).toBe(100);
    expect((await readDocument(key('cards', 'composite'))).data.balance).toBe(2200);
    await insertDocument(key('savingsGoals', 'save-test'), {
      userId: 'test-user',
      name: 'Goal',
      currency: 'UZS',
      savedAmount: 0,
    });
    await savings.contribute('test-user', 'save-test', 100, 'composite');
    expect((await readDocument(key('savingsGoals', 'save-test'))).data.savedAmount).toBe(100);
    await insertDocument(key('subscriptions', 'sub-test'), {
      userId: 'test-user',
      name: 'Subscription',
      icon: 'x',
      amount: 50,
      currency: 'UZS',
      cycle: 'monthly',
      nextBillingDate: 1800000000000,
    });
    const paid = await subscriptions.paySubscription('test-user', 'sub-test', 'composite');
    expect(paid.nextBillingDate).toBeGreaterThan(1800000000000);
    expect((await readDocument(key('cards', 'composite'))).data.balance).toBe(2050);
  });

  it('preserves deposit replenishment, withdrawal and close with balance movements', async () => {
    const deposits = await import('../../src/services/deposit.service');
    await insertDocument(key('cards', 'deposit-card'), { ...card, balance: 1000 });
    await insertDocument(key('deposits', 'deposit-test'), {
      userId: 'test-user',
      bank: 'Synthetic',
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
    await deposits.replenishDeposit('test-user', 'deposit-test', 'deposit-card', 50);
    await deposits.withdrawDeposit('test-user', 'deposit-test', 'deposit-card', 20);
    expect((await readDocument(key('cards', 'deposit-card'))).data.balance).toBe(970);
    const result = await deposits.closeDeposit('test-user', 'deposit-test', 'deposit-card');
    expect(result.total).toBe(130);
    expect((await readDocument(key('cards', 'deposit-card'))).data.balance).toBe(1100);
    expect((await readDocument(key('deposits', 'deposit-test'))).data.isClosed).toBe(true);
  });

  it('clears history without recalculating balances and excludes household operations', async () => {
    const money = await import('../../src/services/transaction.service');
    await insertDocument(key('cards', 'clear'), { ...card, userId: 'clear-user', balance: 321 });
    await insertDocument(key('transactions', 'personal-clear'), {
      userId: 'clear-user',
      cardId: 'clear',
      amount: 123,
      type: 'expense',
    });
    await insertDocument(key('transactions', 'family-keep'), {
      userId: 'clear-user',
      scope: 'household',
    });
    await money.clearAllTransactions('clear-user');
    expect((await readDocument(key('cards', 'clear'))).data.balance).toBe(321);
    expect((await readDocument(key('transactions', 'personal-clear'))).exists).toBe(false);
    expect((await readDocument(key('transactions', 'family-keep'))).exists).toBe(true);
  });

  it('grants a trial once and preserves nested trial history through billing-like merges', async () => {
    const { startTrial } = await import('../../src/services/profile.service');
    await insertDocument(key('profiles', 'trial-user'), { isPremium: false });
    const results = await Promise.allSettled([startTrial('trial-user'), startTrial('trial-user')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const grant = (await readDocument(key('profiles', 'trial-user'))).data.subscription
      .trialGrantedAt;
    await saveDocument(
      key('profiles', 'trial-user'),
      { subscription: { tier: 'free', billingVersion: 2 } },
      { merge: true },
    );
    expect(
      (await readDocument(key('profiles', 'trial-user'))).data.subscription.trialGrantedAt,
    ).toBe(grant);
  });

  it('preserves family membership, private balances and personal-ledger ownership', async () => {
    const family = await import('../../src/services/household.service');
    for (const uid of ['family-owner', 'family-member'])
      await insertDocument(key('profiles', uid), {
        name: uid,
        isPremium: true,
        subscription: { tier: 'premium', premiumUntil: Date.now() + 86400000 },
      });
    const household = await family.createHousehold('family-owner', {
      name: 'Family',
      currency: 'UZS',
    });
    const invite = await family.createInvite('family-owner');
    await family.acceptInvite('family-member', invite.token);
    expect((await family.currentHousehold('family-member'))?.id).toBe(household.id);
    await insertDocument(key('cards', 'family-personal'), {
      ...card,
      userId: 'family-owner',
      balance: 777,
      familyAccess: { householdId: household.id, enabled: true, showBalance: false },
    });
    expect(
      (await family.listHouseholdCards('family-member')).find(
        (row) => row.id === 'family-personal',
      ),
    ).toMatchObject({ balance: 0, balanceHidden: true });
    const categories = await family.listHouseholdCategories('family-owner');
    const category = categories.find((row) => row.type === 'expense')!;
    const transaction = await family.createHouseholdTransaction('family-member', {
      categoryId: category.id,
      cardId: 'family-personal',
      type: 'expense',
      amount: 50,
      currency: 'UZS',
      date: 1,
    });
    expect(transaction.userId).toBe('family-owner');
    expect((await readDocument(key('cards', 'family-personal'))).data.balance).toBe(727);
    await family.updateHouseholdTransaction('family-member', transaction.id, { amount: 60 });
    expect((await readDocument(key('cards', 'family-personal'))).data.balance).toBe(717);
    await family.deleteHouseholdTransaction('family-member', transaction.id);
    expect((await readDocument(key('cards', 'family-personal'))).data.balance).toBe(777);
    await expect(family.listHouseholdCards('outsider')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('consumes an SMS code once and claims Telegram/notification jobs once', async () => {
    const phone = await import('../../src/repositories/phoneVerification.repository');
    await phone.saveIssuedCode({
      phoneDigits: '998900000000',
      codeHash: 'hash',
      purpose: 'signin',
      targetUid: null,
      expiresAtMs: Date.now() + 60000,
      sendCount: 1,
      sendWindowStartMs: Date.now(),
      retainUntilMs: Date.now() + 86400000,
    });
    expect(
      (
        await Promise.all(
          Array.from({ length: 6 }, () => phone.consumeCode('998900000000', 'hash')),
        )
      ).filter(Boolean),
    ).toHaveLength(1);
    const telegram = await import('../../src/telegram/dedupe.repository');
    expect(await telegram.enqueueUpdate(12345, { update_id: 12345 })).toBe(true);
    expect(await telegram.enqueueUpdate(12345, { update_id: 12345 })).toBe(false);
    expect(
      (await Promise.all(Array.from({ length: 6 }, () => telegram.claimUpdate(12345)))).filter(
        Boolean,
      ),
    ).toHaveLength(1);
    await telegram.completeUpdate(12345, 'test-user');
    expect(await telegram.claimUpdate(12345)).toBe(false);
    const notifications = await vi.importActual<
      typeof import('../../src/notifications/queue.repository')
    >('../../src/notifications/queue.repository');
    await insertDocument(key('notifications', 'claim-once'), {
      status: 'pending',
      nextAttemptAt: 0,
      attempts: 0,
    });
    expect(
      (
        await Promise.all(
          Array.from({ length: 6 }, () =>
            notifications.claimNotification('claim-once', Date.now()),
          ),
        )
      ).filter(Boolean),
    ).toHaveLength(1);
  });

  it('applies signed billing events monotonically, deduplicates them, and retains trial history', async () => {
    const { billingInternalRouter } = await import('../../src/routes/billingInternal.routes');
    await insertDocument(key('profiles', 'billing-user'), {
      isPremium: false,
      subscription: { trialGrantedAt: 123 },
    });
    const app = express();
    app.use(
      express.json({
        verify(req, _res, buffer) {
          (req as any).rawBody = Buffer.from(buffer);
        },
      }),
    );
    app.use((req, _res, next) => {
      (req as any).log = { info() {} };
      next();
    });
    app.use('/events', billingInternalRouter);
    app.use((error: any, _req: any, res: any, _next: any) =>
      res.status(error.statusCode || 500).json({ code: error.code }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const event = (version: number) => ({
      eventId: randomUUID(),
      version,
      type: 'billing.entitlement.updated',
      occurredAt: new Date().toISOString(),
      userId: 'billing-user',
      orderId: randomUUID(),
      tier: 'premium',
      source: 'atmos',
      isTrial: false,
      validFrom: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
    });
    const deliver = async (body: ReturnType<typeof event>, badSignature = false) => {
      const raw = JSON.stringify(body);
      const timestamp = String(Date.now());
      const signature = createHmac('sha256', 'local-integration-secret-not-production')
        .update(`${timestamp}.${raw}`)
        .digest('hex');
      const response = await fetch(`http://127.0.0.1:${address.port}/events`, {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-pulim-event-id': body.eventId,
          'x-pulim-timestamp': timestamp,
          'x-pulim-signature': badSignature ? '0'.repeat(64) : signature,
        },
      });
      await response.arrayBuffer();
      return response.status;
    };
    try {
      const newest = event(3);
      expect(await deliver(newest, true)).toBe(401);
      expect(await deliver(newest)).toBe(204);
      expect(await deliver(newest)).toBe(204);
      expect(await deliver(event(2))).toBe(204);
      const profile = (await readDocument(key('profiles', 'billing-user'))).data;
      expect(profile.subscription).toMatchObject({ billingVersion: 3, trialGrantedAt: 123 });
      expect(profile.isPremium).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
