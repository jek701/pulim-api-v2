import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { internalHmac, internalSignature } from '../../src/middleware/internalHmac';
import { request } from './helpers';
const secret = 'synthetic-shared-secret-at-least-32';
function router(key: string | undefined = secret, scheme: 'billing' | 'crm' = 'crm') {
  const router = Router();
  router.use(internalHmac({ secret: () => key, scheme }));
  router.use((_req, res) => res.status(204).end());
  return router;
}
function headers(raw = '{}', timestamp = String(Date.now()), id = randomUUID()) {
  return {
    'x-pulim-timestamp': timestamp,
    'x-pulim-request-id': id,
    'x-pulim-signature': internalSignature(secret, timestamp, raw, id),
  };
}
describe('internal HMAC', () => {
  it('returns 404 when CRM is disabled before inspecting authentication', async () => {
    const disabled = Router();
    disabled.use(internalHmac({ secret: () => undefined, scheme: 'crm' }));
    expect((await request(disabled)).status).toBe(404);
  });
  it('rejects missing headers, wrong signatures, stale timestamps and malformed request ids', async () => {
    for (const authentication of [
      {},
      { ...headers(), 'x-pulim-signature': '00'.repeat(32) },
      headers('{}', String(Date.now() - 300001)),
      headers('{}', String(Date.now()), 'not-uuid'),
    ])
      expect((await request(router(), { headers: authentication })).status).toBe(401);
  });
  it('signs exact raw bytes including whitespace and rejects a replay', async () => {
    const app = router();
    const authentication = headers('{ "n": 1 }');
    const input = { headers: authentication, extra: { rawBody: Buffer.from('{ "n": 1 }') } };
    expect((await request(app, input)).status).toBe(204);
    expect((await request(app, input)).status).toBe(401);
    expect(
      (await request(router(), { headers: headers('{"n":1}'), extra: input.extra })).status,
    ).toBe(401);
  });
  it('GET signs an empty body; a different request id permits a business retry', async () => {
    const app = router();
    expect((await request(app, { method: 'GET', headers: headers('') })).status).toBe(204);
    expect((await request(app, { method: 'GET', headers: headers('') })).status).toBe(204);
  });
  it('keeps the billing signing string, missing-secret 503 and repeat behavior', async () => {
    const timestamp = String(Date.now());
    const authentication = {
      'x-pulim-event-id': randomUUID(),
      'x-pulim-timestamp': timestamp,
      'x-pulim-signature': internalSignature(secret, timestamp, '{}'),
    };
    const app = router(secret, 'billing');
    expect((await request(app, { headers: authentication })).status).toBe(204);
    expect((await request(app, { headers: authentication })).status).toBe(204);
    const missing = Router();
    missing.use(internalHmac({ secret: () => undefined, scheme: 'billing' }));
    expect((await request(missing)).status).toBe(503);
  });
});
