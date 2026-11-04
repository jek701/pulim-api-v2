import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ push: vi.fn(), capture: vi.fn() }));
vi.mock('../../src/push/availability', () => ({ pushAvailable: mocks.push }));
vi.mock('../../src/capture/availability', () => ({ captureCapabilities: mocks.capture }));
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

it.each([{ voice: false, receipt: false }, { voice: true, receipt: true }])(
  'advertises capture %j next to the existing capabilities, unchanged', async capture => {
    mocks.push.mockResolvedValue(true);
    mocks.capture.mockResolvedValue(capture);
    const body = await (await fetch(url)).json();
    expect(body).toMatchObject({ contract: 1, pushNotifications: true, onboardingCategories: true, capture });
    expect(Object.keys(body.capture).sort()).toEqual(['receipt', 'voice']);
  });
