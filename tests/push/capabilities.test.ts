import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ available: vi.fn() }));
vi.mock('../../src/push/availability', () => ({ pushAvailable: mocks.available }));
import { syncRouter } from '../../src/routes/sync.routes';

let server: Server;
let url: string;
beforeAll(async () => {
  const app = express();
  app.use('/v1/sync', syncRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}/v1/sync/capabilities`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

it.each([false, true])('advertises the checked push readiness (%s) in capabilities', async available => {
  mocks.available.mockResolvedValue(available);
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ contract: 1, pushNotifications: available });
});
