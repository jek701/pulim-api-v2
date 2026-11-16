import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  records: new Map<string, any>(),
  tail: Promise.resolve() as Promise<unknown>,
  env: {
    PULIM_CRM_INTERNAL_SECRET: 'synthetic-shared-secret-at-least-32' as string | undefined,
    PULIM_CRM_API_URL: 'https://crm.example.test' as string | undefined,
    BACKGROUND_JOBS_ENABLED: true,
    MAINTENANCE_MODE: false,
  },
  warn: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({ env: state.env }));
vi.mock('../../src/db/documents', async () => (await import('./helpers')).documentMock(state));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: state.warn } }));
import {
  rememberCrmDeletion,
  notifyCrmDeletion,
  runCrmDeletionFanouts,
} from '../../src/crm/deletion';
import { internalSignature } from '../../src/middleware/internalHmac';
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1794801600000);
  state.records.clear();
  state.tail = Promise.resolve();
  state.env.PULIM_CRM_INTERNAL_SECRET = 'synthetic-shared-secret-at-least-32';
  state.env.PULIM_CRM_API_URL = 'https://crm.example.test';
  state.warn.mockClear();
  fetchMock.mockReset().mockResolvedValue({ status: 204 });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('account deletion fan-out', () => {
  it('signs the exact body, expects 204 and removes the operational tombstone on success', async () => {
    expect(await rememberCrmDeletion('synthetic-uid')).toBe(true);
    const record = [...state.records.values()][0];
    expect(record.userId).toBeUndefined();
    await notifyCrmDeletion('synthetic-uid', true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://crm.example.test/internal/v1/users/deleted');
    expect(options.body).toBe(JSON.stringify({ uid: 'synthetic-uid' }));
    const h = options.headers;
    expect(h['X-Pulim-Signature']).toBe(
      internalSignature(
        state.env.PULIM_CRM_INTERNAL_SECRET!,
        h['X-Pulim-Timestamp'],
        options.body,
        h['X-Pulim-Request-Id'],
      ),
    );
    expect(h['X-Pulim-Request-Id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe('error');
    expect(state.records.size).toBe(0);
  });
  it('failure never fails deletion; retains the durable job and worker retries with a fresh request id', async () => {
    fetchMock.mockResolvedValueOnce({ status: 503 });
    await rememberCrmDeletion('synthetic-uid');
    await expect(notifyCrmDeletion('synthetic-uid', true)).resolves.toBeUndefined();
    expect(state.records.size).toBe(1);
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain('synthetic-uid');
    vi.setSystemTime(Date.now() + 60000);
    await runCrmDeletionFanouts();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.records.size).toBe(0);
    expect(fetchMock.mock.calls[0][1].headers['X-Pulim-Request-Id']).not.toBe(
      fetchMock.mock.calls[1][1].headers['X-Pulim-Request-Id'],
    );
  });
  it.each(['url', 'secret'])('skips silently with missing %s', async (field) => {
    if (field === 'url') state.env.PULIM_CRM_API_URL = undefined;
    else state.env.PULIM_CRM_INTERNAL_SECRET = undefined;
    expect(await rememberCrmDeletion('u')).toBe(false);
    await notifyCrmDeletion('u', false);
    await runCrmDeletionFanouts();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.warn).not.toHaveBeenCalled();
    expect(state.records.size).toBe(0);
  });
  it('waits for profile removal and drops an old tombstone if a new profile already exists', async () => {
    await rememberCrmDeletion('u');
    state.records.set('profiles/u', { deletionRequestedAt: 1 });
    await notifyCrmDeletion('u', true);
    expect(fetchMock).not.toHaveBeenCalled();
    state.records.set('profiles/u', { updatedAt: Date.now() });
    vi.setSystemTime(Date.now() + 60000);
    await runCrmDeletionFanouts();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.records.size).toBe(1);
  });
  it('uses three bounded attempts when durable storage is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('private transport error'));
    const pending = notifyCrmDeletion('u', false);
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(state.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uidHash: expect.any(String) }),
      'crm.deletion.retry_exhausted',
    );
  });
});
