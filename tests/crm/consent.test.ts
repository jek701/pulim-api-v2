import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  records: new Map<string, any>(),
  tail: Promise.resolve() as Promise<unknown>,
}));
vi.mock('../../src/db/documents', async () => (await import('./helpers')).documentMock(state));
vi.mock('../../src/services/profile.service', () => ({}));
vi.mock('../../src/services/household.service', () => ({}));
vi.mock('../../src/notifications/settings', () => ({}));
import { profileRouter } from '../../src/routes/profile.routes';
import { request } from './helpers';
const now = 1794801600000;
const body = { granted: true, version: '1.0', language: 'ru', screen: 'sheet' };
const call = (input: any = body, provider = 'apple.com', type = 'ai') =>
  request(profileRouter, {
    method: 'PUT',
    url: `/consents/${type}`,
    body: input,
    extra: { uid: 'u', claims: { firebase: { sign_in_provider: provider } } },
  });
const consent = () => state.records.get('profiles/u').consents?.ai;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  state.tail = Promise.resolve();
  state.records.clear();
  state.records.set('profiles/u', { updatedAt: 1 });
});
afterEach(() => vi.useRealTimers());
describe('AI consent route', () => {
  it('records a server-stamped consent, repeat does not mutate it, and revoke/regrant update evidence', async () => {
    expect((await call()).status).toBe(204);
    expect(consent()).toEqual({ ...body, at: now, serverAt: now, revokedAt: null });
    vi.setSystemTime(now + 1000);
    await call();
    expect(consent().serverAt).toBe(now);
    await call({ ...body, granted: false });
    expect(consent().revokedAt).toBe(now + 1000);
    vi.setSystemTime(now + 2000);
    await call({ ...body, granted: false });
    expect(consent().revokedAt).toBe(now + 1000);
    await call();
    expect(consent().revokedAt).toBeNull();
  });
  it('clamps client timestamps to one day and retries remain idempotent', async () => {
    await call({ ...body, at: now + 9 * 86400000 });
    expect(consent().at).toBe(now + 86400000);
    vi.setSystemTime(now + 1000);
    await call({ ...body, at: now + 9 * 86400000 });
    expect(consent().serverAt).toBe(now);
    await call({ ...body, version: '2.0', at: 0 });
    expect(consent().at).toBe(Date.now() - 86400000);
    const saved = { ...consent() };
    vi.setSystemTime(now + 2000);
    await call({ ...body, version: '2.0', at: 0 });
    expect(consent()).toEqual(saved);
  });
  it('anonymous sessions get 403 without a write', async () => {
    expect((await call(body, 'anonymous')).status).toBe(403);
    expect(consent()).toBeUndefined();
  });
  it('rejects invalid type, version, language, screen, granted and time', async () => {
    expect((await call(body, 'apple.com', 'tracking')).status).toBe(400);
    for (const patch of [
      { version: 'a'.repeat(21) },
      { language: 'de' },
      { screen: 'other' },
      { granted: 1 },
      { at: -1 },
      { at: 1.1 },
    ])
      expect((await call({ ...body, ...patch })).status).toBe(400);
    expect(consent()).toBeUndefined();
  });
  it('never creates a missing profile', async () => {
    state.records.clear();
    expect((await call()).status).toBe(404);
  });
});
