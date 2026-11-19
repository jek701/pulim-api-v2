import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env', () => ({
  env: { PULIM_PAYMENT_INTERNAL_SECRET: 'synthetic-test-key' },
}));
const state = vi.hoisted(() => ({ profile: undefined as any, save: vi.fn(), insert: vi.fn() }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => table,
  documentKey: (table: string, id: string) => ({ table, id }),
  runSqlTransaction: (fn: any) =>
    fn({
      read: async (ref: any) =>
        ref.table === 'profiles'
          ? { exists: Boolean(state.profile), data: state.profile }
          : { exists: false },
      save: state.save,
      insert: state.insert,
    }),
}));
import { billingInternalRouter } from '../../src/routes/billingInternal.routes';

describe('billing events', () => {
  it.each([[undefined, 'none'], [{ deletionRequestedAt: 1 }, 'none'], [{ deletionRequestedAt: 1 }, 'apple']])(
    'acknowledges absent/deleting profiles without creating anything: %j, %s',
    async (profile, source) => {
      state.profile = profile;
      state.save.mockClear();
      state.insert.mockClear();
      const event = {
        eventId: '00000000-0000-4000-8000-000000000001',
        orderId: '00000000-0000-4000-8000-000000000002',
        version: 1,
        type: 'billing.entitlement.updated',
        occurredAt: new Date().toISOString(),
        userId: 'synthetic-user',
        tier: 'free',
        source,
        isTrial: false,
        validFrom: null,
        validUntil: null,
      };
      const raw = JSON.stringify(event);
      const timestamp = String(Date.now());
      const req = new IncomingMessage(new Socket());
      req.method = 'POST';
      req.url = '/';
      req.headers = {
        'x-pulim-event-id': event.eventId,
        'x-pulim-timestamp': timestamp,
        'x-pulim-signature': createHmac('sha256', 'synthetic-test-key')
          .update(`${timestamp}.${raw}`)
          .digest('hex'),
      };
      Object.assign(req, { body: event, rawBody: Buffer.from(raw), log: { info: vi.fn() } });
      const res = new ServerResponse(req);
      const app = express();
      app.use(billingInternalRouter);
      const status = await new Promise<number>((resolve, reject) => {
        res.end = (() => {
          resolve(res.statusCode);
          return res;
        }) as typeof res.end;
        app(req, res, reject);
      });
      expect(status).toBe(204);
      expect(state.save).not.toHaveBeenCalled();
      expect(state.insert).not.toHaveBeenCalled();
    },
  );
});

async function deliver(event: Record<string, any>) {
  const raw = JSON.stringify(event);
  const timestamp = String(Date.now());
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.url = '/';
  req.headers = {
    'x-pulim-event-id': event.eventId,
    'x-pulim-timestamp': timestamp,
    'x-pulim-signature': createHmac('sha256', 'synthetic-test-key').update(`${timestamp}.${raw}`).digest('hex'),
  };
  Object.assign(req, { body: event, rawBody: Buffer.from(raw), log: { info: vi.fn() } });
  const res = new ServerResponse(req);
  const app = express();
  app.use(billingInternalRouter);
  return new Promise<number>((resolve, reject) => {
    res.end = (() => { resolve(res.statusCode); return res; }) as typeof res.end;
    app(req, res, reject);
  });
}

it('applies Apple introductory offer metadata and accepts extra fields', async () => {
  state.profile = {};
  state.save.mockClear();
  const event = {
    eventId: '00000000-0000-4000-8000-000000000001',
    orderId: '00000000-0000-4000-8000-000000000002',
    version: 1, type: 'billing.entitlement.updated', occurredAt: new Date().toISOString(),
    userId: 'synthetic-user', tier: 'premium', source: 'apple', isTrial: true,
    autoRenew: false, planCode: 'premium_1_month', environment: 'Sandbox', extra: 'ignored',
    validFrom: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
  };
  expect(await deliver(event)).toBe(204);
  expect(state.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    isPremium: true, subscription: expect.objectContaining({ source: 'apple', isTrial: true,
      autoRenew: false, planCode: 'premium_1_month', hadApplePremium: true }),
  }), { merge: true });
});

it('records Apple history even for an older event without replacing the current entitlement', async () => {
  state.profile = { subscription: { billingVersion: 2 } };
  state.save.mockClear();
  expect(await deliver({ eventId: '00000000-0000-4000-8000-000000000001',
    orderId: '00000000-0000-4000-8000-000000000002', version: 1,
    type: 'billing.entitlement.updated', occurredAt: new Date().toISOString(),
    userId: 'synthetic-user', tier: 'free', source: 'apple', isTrial: false,
    validFrom: null, validUntil: null })).toBe(204);
  expect(state.save).toHaveBeenCalledWith(expect.anything(),
    { subscription: { hadApplePremium: true } }, { merge: true });
});
