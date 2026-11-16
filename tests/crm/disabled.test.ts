import { beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ log: vi.fn(), mount: vi.fn() }));
vi.mock('../../src/config/env', () => ({ env: {}, corsOrigins: [], isProd: false }));
vi.mock('../../src/routes', () => ({ mountRoutes: mocks.mount }));
vi.mock('../../src/middleware/requestContext', () => ({
  requestLogger: (_req: unknown, _res: unknown, next: () => void) => {
    mocks.log();
    next();
  },
}));
vi.mock('../../src/middleware/notFound', () => ({
  notFound: (_req: unknown, res: any) => res.status(404).end(),
}));
vi.mock('../../src/middleware/errorHandler', () => ({
  errorHandler: (_error: unknown, _req: unknown, res: any, _next: unknown) => res.status(500).end(),
}));
import { createApp } from '../../src/app';
import { request } from './helpers';
beforeEach(() => vi.clearAllMocks());
describe('disabled CRM application boundary', () => {
  it.each(['/internal/v1/crm/users', '/internal/v1/crm/messages', '/internal/v1/crm/unknown'])(
    'returns 404 before the request logger: %s',
    async (url) => {
      expect((await request(createApp(), { url })).status).toBe(404);
      expect(mocks.log).not.toHaveBeenCalled();
    },
  );
});
