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

describe('billing after account deletion', () => {
  it.each([undefined, { deletionRequestedAt: 1 }])(
    'acknowledges absent/deleting profiles without creating anything: %j',
    async (profile) => {
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
        source: 'none',
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
