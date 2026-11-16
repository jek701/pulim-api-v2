import { beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  facts: vi.fn(),
  queue: vi.fn(),
  statuses: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({
  env: { PULIM_CRM_INTERNAL_SECRET: 'synthetic-secret-at-least-32-characters' },
}));
vi.mock('../../src/crm/facts', () => ({ listCrmUsers: mocks.list, getCrmFacts: mocks.facts }));
vi.mock('../../src/crm/messages', () => ({
  queueCrmMessage: mocks.queue,
  crmMessageStatuses: mocks.statuses,
}));
import { crmInternalRouter } from '../../src/routes/crmInternal.routes';
import { internalSignature } from '../../src/middleware/internalHmac';
import { request } from './helpers';
const call = (url: string, body?: unknown, method = 'POST') => {
  const timestamp = String(Date.now());
  const id = randomUUID();
  return request(crmInternalRouter, {
    url,
    method,
    body,
    headers: {
      'x-pulim-timestamp': timestamp,
      'x-pulim-request-id': id,
      'x-pulim-signature': internalSignature(
        'synthetic-secret-at-least-32-characters',
        timestamp,
        method === 'GET' ? '' : JSON.stringify(body),
        id,
      ),
    },
  });
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ users: [], nextCursor: null });
  mocks.facts.mockResolvedValue({ users: [] });
  mocks.queue.mockResolvedValue({ status: 'queued', reason: null });
  mocks.statuses.mockResolvedValue({ messages: [] });
});
describe('authenticated CRM routes', () => {
  it('reads query and body contracts without requiring Firebase authentication', async () => {
    expect((await call('/users?limit=3&updatedSince=123', undefined, 'GET')).body).toEqual({
      users: [],
      nextCursor: null,
    });
    expect(mocks.list).toHaveBeenCalledWith({ limit: 3, updatedSince: 123 });
    expect((await call('/users/facts', { uids: ['u'] })).body).toEqual({ users: [] });
    expect(mocks.facts).toHaveBeenCalledWith(['u']);
    expect(
      (
        await call('/messages', {
          mid: 'm',
          uid: 'u',
          channel: 'push',
          category: 'marketing',
          title: 't',
          body: 'b',
          link: '/',
        })
      ).body,
    ).toEqual({ status: 'queued', reason: null });
    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({ ttlSec: 86400 }));
    expect((await call('/messages/status', { mids: ['m'] })).body).toEqual({ messages: [] });
    expect(mocks.statuses).toHaveBeenCalledWith(['m']);
  });
  it('rejects invalid bodies before reaching services', async () => {
    expect((await call('/users?limit=0', undefined, 'GET')).status).toBe(400);
    expect((await call('/users/facts', { uids: [] })).status).toBe(400);
    expect((await call('/messages', {})).status).toBe(400);
    expect((await call('/messages/status', { mids: [] })).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.statuses).not.toHaveBeenCalled();
  });
});
