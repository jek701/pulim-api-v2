import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env', () => ({
  env: { AI_RATE_LIMIT_PER_MIN: 60, LOG_LEVEL: 'silent' },
  isProd: true,
}));
const mocks = vi.hoisted(() => ({ deleteAccount: vi.fn() }));
vi.mock('../../src/services/accountDeletion.service', () => mocks);
import { accountRouter } from '../../src/routes/account.routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { idempotency, honouredStatus } from '../../src/middleware/idempotency';
import { setSyncEnabled } from '../../src/db/syncIndex';
import { AppError } from '../../src/utils/AppError';

let app: ReturnType<typeof express>;
beforeAll(async () => {
  setSyncEnabled(true);
  app = express();
  app.use((req, _res, next) => {
    req.uid = String(req.header('x-test-uid') ?? 'user');
    req.claims = {
      firebase: { sign_in_provider: req.header('x-anonymous') ? 'anonymous' : 'password' },
    } as any;
    next();
  });
  app.use(idempotency);
  app.use('/account', accountRouter);
  app.use(errorHandler);
});
afterAll(() => setSyncEnabled(false));
const post = async (uid: string, body: unknown, extra: Record<string, string> = {}) => {
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.url = '/account/delete';
  req.headers = {
    'x-test-uid': uid,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
  };
  (req as any).body = body;
  const res = new ServerResponse(req);
  return new Promise<{
    status: number;
    headers: { get: (name: string) => unknown };
    json: () => Promise<any>;
  }>((resolve, reject) => {
    res.end = ((chunk?: any) => {
      res.emit('finish');
      resolve({
        status: res.statusCode,
        headers: { get: (name) => res.getHeader(name) },
        json: async () => JSON.parse(String(chunk)),
      });
      return res;
    }) as typeof res.end;
    app(req, res);
    res.on('error', reject);
  });
};

describe('POST /account/delete', () => {
  it('returns the validation envelope for malformed JSON parser errors', () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    errorHandler(
      { type: 'entity.parse.failed' },
      { method: 'POST', originalUrl: '/v1/account/delete' } as any,
      response as any,
      vi.fn(),
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON request.' },
    });
  });
  it('keeps malformed JSON behaviour on other routes unchanged', () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    errorHandler(
      { type: 'entity.parse.failed' },
      { method: 'POST', originalUrl: '/v1/profile/bootstrap' } as any,
      response as any,
      vi.fn(),
    );
    expect(response.status).toHaveBeenCalledWith(500);
  });
  it('requires exact confirmation', async () => {
    for (const [index, body] of [
      null,
      {},
      { confirm: 'delete' },
      { confirm: 'DELETE', extra: true },
    ].entries()) {
      const response = await post(`validation-${index}`, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.code).toBe('VALIDATION_ERROR');
    }
  });
  it('rejects anonymous Firebase users', async () => {
    const response = await post('anonymous', { confirm: 'DELETE' }, { 'x-anonymous': '1' });
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.code).toBe('FORBIDDEN');
  });
  it('limits each uid to three requests per hour', async () => {
    for (let i = 0; i < 3; i++)
      expect((await post('limited', { confirm: 'DELETE' })).status).toBe(204);
    const response = await post('limited', { confirm: 'DELETE' });
    expect(response.status).toBe(429);
    expect(((await response.json()) as any).error.code).toBe('RATE_LIMITED');
    expect((await post('another', { confirm: 'DELETE' })).status).toBe(204);
  });
  it('does not consume slots for invalid bodies or 503 responses', async () => {
    for (let i = 0; i < 4; i++) expect((await post('bad-body', {})).status).toBe(400);
    expect((await post('bad-body', { confirm: 'DELETE' })).status).toBe(204);
    for (let i = 0; i < 4; i++) {
      mocks.deleteAccount.mockRejectedValueOnce(new AppError(503, 'ACCOUNT_DELETION_FAILED'));
      expect((await post('outage', { confirm: 'DELETE' })).status).toBe(503);
    }
    expect((await post('outage', { confirm: 'DELETE' })).status).toBe(204);
  });
  it('ignores idempotency keys and executes a retry after a partial failure', async () => {
    expect(honouredStatus('POST', '/account/delete')).toBeUndefined();
    mocks.deleteAccount
      .mockRejectedValueOnce(new AppError(503, 'ACCOUNT_DELETION_FAILED'))
      .mockResolvedValue(undefined);
    const headers = { 'Idempotency-Key': 'same-key-0123456789' };
    expect((await post('retry', { confirm: 'DELETE' }, headers)).status).toBe(503);
    const response = await post('retry', { confirm: 'DELETE' }, headers);
    expect(response.status).toBe(204);
    expect(response.headers.get('Idempotency-Ignored')).toBe('true');
  });
});
