import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  remove: vi.fn(),
  active: vi.fn(),
  patch: vi.fn(),
  anonymous: false,
  available: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({ env: { APNS_BUNDLE_ID: 'com.izik.pulim' } }));
vi.mock('../../src/push/kick', () => ({ kickPushPlanning: vi.fn() }));
vi.mock('../../src/push/availability', () => ({ pushAvailable: mocks.available }));
vi.mock('../../src/push/devices.repository', () => ({
  registerDevice: mocks.register,
  unregisterDevice: mocks.remove,
  pushActive: mocks.active,
}));
vi.mock('../../src/notifications/settings', () => ({ patchNotificationSettings: mocks.patch }));
import { pushRouter } from '../../src/routes/push';
import { notificationSettingsRouter } from '../../src/routes/notificationSettings.routes';

describe('authenticated push HTTP contract', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.uid = 'authenticated-user';
      req.claims = {
        firebase: { sign_in_provider: mocks.anonymous ? 'anonymous' : 'password' },
      } as any;
      next();
    });
    app.use('/v1/push', pushRouter);
    app.use('/v1/profile/notifications', notificationSettingsRouter);
    app.use(((error: any, _req: unknown, res: express.Response, _next: unknown) => {
      res.status(error.statusCode ?? 500).json({ error: { code: error.code } });
    }) as express.ErrorRequestHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.anonymous = false;
    mocks.register.mockResolvedValue({ id: 'device-id', environment: 'sandbox', disabledAt: null });
    mocks.remove.mockResolvedValue(undefined);
    mocks.patch.mockImplementation(async (_uid, input) => ({ enabled: true, ...input }));
    mocks.active.mockResolvedValue(true);
    mocks.available.mockResolvedValue(true);
  });
  const body = {
    token: 'AB'.repeat(32),
    platform: 'ios',
    environment: 'sandbox',
    bundleId: 'com.izik.pulim',
    appVersion: '1.0',
    buildNumber: '1',
    language: 'uz',
    timezone: 'Asia/Tashkent',
  };
  it('returns the shared registration response and uses the authenticated owner', async () => {
    const response = await fetch(`${base}/v1/push/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, uid: 'untrusted-user' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      device: { id: 'device-id', environment: 'sandbox', enabled: true },
    });
    expect(mocks.register).toHaveBeenCalledWith('authenticated-user', {
      ...body,
      token: body.token.toLowerCase(),
    });
  });
  it('rejects authenticated anonymous guest registration before reaching storage', async () => {
    mocks.anonymous = true;
    const response = await fetch(`${base}/v1/push/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'AUTH_REQUIRED' } });
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('rejects invalid registration before reaching storage', async () => {
    const response = await fetch(`${base}/v1/push/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, timezone: 'invalid' }),
    });
    expect(response.status).toBe(400);
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('rejects a different bundle before registration', async () => {
    const response = await fetch(`${base}/v1/push/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, bundleId: 'com.other.app' }),
    });
    expect(response.status).toBe(400);
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('returns a clear 503 when push or its registry is unavailable', async () => {
    mocks.available.mockResolvedValue(false);
    const response = await fetch(`${base}/v1/push/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'PUSH_UNAVAILABLE' } });
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('returns empty 204 for repeated owned-token deletion', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/v1/push/devices/${body.token}`, { method: 'DELETE' });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    }
    expect(mocks.remove).toHaveBeenCalledWith('authenticated-user', body.token.toLowerCase());
  });
  it('keeps enabled-only patches and computes pushActive server-side', async () => {
    const response = await fetch(`${base}/v1/profile/notifications`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, pushActive: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, pushActive: true });
    expect(mocks.patch).toHaveBeenCalledWith('authenticated-user', { enabled: false });
  });
});
