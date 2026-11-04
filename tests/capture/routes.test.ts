import express from 'express';
import type { Server } from 'node:http';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { syntheticJpeg, syntheticM4a } from './helpers';

const mocks = vi.hoisted(() => ({
  anonymous: false, caps: vi.fn(), quota: vi.fn(), voice: vi.fn(), photo: vi.fn(), soliq: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../src/capture/availability', () => ({ captureCapabilities: mocks.caps }));
vi.mock('../../src/capture/quota', () => ({ captureQuota: mocks.quota }));
vi.mock('../../src/capture/service', () => ({
  captureVoice: mocks.voice, capturePhoto: mocks.photo, captureSoliq: mocks.soliq,
}));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: mocks.warn } }));
import { captureRouter } from '../../src/routes/capture.routes';
import { AppError } from '../../src/utils/AppError';

const quota = { used: 2, limit: 5, resetsAt: '2026-11-30T19:00:00.000Z', premium: false };
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = 'user-1';
    req.claims = { firebase: { sign_in_provider: mocks.anonymous ? 'anonymous' : 'password' } } as any;
    next();
  });
  app.use('/v1/capture', captureRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.anonymous = false;
  mocks.caps.mockResolvedValue({ voice: true, receipt: true });
  mocks.quota.mockResolvedValue(quota);
  mocks.voice.mockResolvedValue({ transcript: 'кофе 25 минг', drafts: [], quota });
  mocks.photo.mockResolvedValue({ receipt: {}, drafts: [], quota });
  mocks.soliq.mockResolvedValue({ receipt: {}, drafts: [], quota });
});

const audio = (bytes = syntheticM4a(5), type = 'audio/mp4') => new Blob([new Uint8Array(bytes)], { type });
const form = (parts: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(parts)) data.append(name, value, ...(value instanceof Blob ? ['file'] : []) as []);
  return data;
};
const json = (path: string, body: unknown) => fetch(`${base}/v1/capture${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('capture HTTP contract', () => {
  it('is not for guests', async () => {
    mocks.anonymous = true;
    for (const response of [await fetch(`${base}/v1/capture/quota`), await json('/receipt/soliq', { url: 'https://ofd.soliq.uz/epi' })]) {
      expect(response.status).toBe(401);
    }
    expect(mocks.soliq).not.toHaveBeenCalled();
  });

  it('stays dark per feature: no voice flag, no voice route, no probing of the pipeline', async () => {
    mocks.caps.mockResolvedValue({ voice: false, receipt: true });
    const response = await fetch(`${base}/v1/capture/voice`, { method: 'POST', body: form({ audio: audio() }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'capture_unavailable' });
    expect(mocks.voice).not.toHaveBeenCalled();
    expect((await json('/receipt/soliq', { url: 'https://ofd.soliq.uz/epi' })).status).toBe(200);
    mocks.caps.mockResolvedValue({ voice: false, receipt: false });
    expect((await fetch(`${base}/v1/capture/quota`)).status).toBe(503);
  });

  it('GET /quota returns exactly used, limit, resetsAt and premium', async () => {
    const response = await fetch(`${base}/v1/capture/quota`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(quota);
    expect(mocks.quota).toHaveBeenCalledWith('user-1');
  });

  it('accepts a multipart voice note with language and timezone and returns the service body', async () => {
    const response = await fetch(`${base}/v1/capture/voice`, { method: 'POST',
      body: form({ audio: audio(), language: 'ru', timezone: 'Asia/Tashkent' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcript: 'кофе 25 минг', drafts: [], quota });
    expect(mocks.voice).toHaveBeenCalledWith('user-1', expect.any(Buffer), 'audio/mp4', 'Asia/Tashkent', 'ru');
  });

  it.each([
    ['no file', () => form({ language: 'ru' })],
    ['a different field name', () => form({ file: audio() })],
    ['an unknown field', () => form({ audio: audio(), uid: 'someone-else' })],
    ['an unsupported language', () => form({ audio: audio(), language: 'de' })],
    ['an invalid timezone', () => form({ audio: audio(), timezone: 'Mars/Base' })],
    ['audio over 62 seconds', () => form({ audio: audio(syntheticM4a(90)) })],
    ['a non-audio body', () => form({ audio: audio(Buffer.from('not audio at all'), 'audio/mp4') })],
    ['a wrong container label', () => form({ audio: audio(syntheticM4a(5), 'audio/ogg') })],
    ['more than 3 MB', () => form({ audio: audio(Buffer.alloc(3 * 1024 * 1024 + 1024)) })],
  ])('rejects %s before any recognition work', async (_name, body) => {
    const response = await fetch(`${base}/v1/capture/voice`, { method: 'POST', body: body() });
    expect(response.status).toBe(400);
    expect(mocks.voice).not.toHaveBeenCalled();
  });

  it('rejects a non-multipart voice request', async () => {
    expect((await json('/voice', { audio: 'x' })).status).toBe(400);
    expect(mocks.voice).not.toHaveBeenCalled();
  });

  it('accepts a bounded JPEG receipt photo and rejects other images and oversize dimensions', async () => {
    const image = (bytes: Buffer, type = 'image/jpeg') => form({ image: new Blob([new Uint8Array(bytes)], { type }), timezone: 'Asia/Tashkent' });
    expect((await fetch(`${base}/v1/capture/receipt/photo`, { method: 'POST', body: image(syntheticJpeg(1500, 2000)) })).status).toBe(200);
    expect(mocks.photo).toHaveBeenCalledWith('user-1', expect.any(Buffer), 'Asia/Tashkent');
    for (const bad of [image(syntheticJpeg(1500, 2001)), image(syntheticJpeg(100, 100), 'image/png'), image(Buffer.from('nope'))]) {
      expect((await fetch(`${base}/v1/capture/receipt/photo`, { method: 'POST', body: bad })).status).toBe(400);
    }
    expect(mocks.photo).toHaveBeenCalledOnce();
  });

  it('POST /receipt/soliq validates the body and passes url and timezone', async () => {
    const url = 'https://ofd.soliq.uz/epi?t=EPTEST&r=1&c=20261103123000&s=1';
    expect((await json('/receipt/soliq', { url, timezone: 'Asia/Tashkent' })).status).toBe(200);
    expect(mocks.soliq).toHaveBeenCalledWith('user-1', url, 'Asia/Tashkent');
    for (const body of [{}, { url: 5 }, { url, extra: 1 }, { url, timezone: 'bad' }]) {
      expect((await json('/receipt/soliq', body)).status).toBe(400);
    }
  });

  it('402 carries code and quota in the contract shape, plus the usual error envelope', async () => {
    mocks.voice.mockRejectedValue(new AppError(402, 'capture_quota_exceeded', undefined, { quota: { ...quota, used: 5 } }));
    const response = await fetch(`${base}/v1/capture/voice`, { method: 'POST', body: form({ audio: audio() }) });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: 'capture_quota_exceeded', quota: { used: 5, limit: 5, premium: false },
      error: { code: 'capture_quota_exceeded' },
    });
  });

  it('502 soliq_unavailable lets the app offer the photo path', async () => {
    mocks.soliq.mockRejectedValue(new AppError(502, 'soliq_unavailable', 'Soliq is unavailable. Try a photo of the receipt.'));
    const response = await json('/receipt/soliq', { url: 'https://ofd.soliq.uz/epi?t=EPTEST&r=1&c=20261103123000&s=1' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'soliq_unavailable' });
  });

  it('maps provider and model-output failures to a generic 502 without leaking them', async () => {
    mocks.photo.mockRejectedValue(new Error('Incorrect API key sk-LEAK; body: Synthetic Buyer +998901234567'));
    const body = form({ image: new Blob([new Uint8Array(syntheticJpeg(10, 10))], { type: 'image/jpeg' }) });
    const response = await fetch(`${base}/v1/capture/receipt/photo`, { method: 'POST', body });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'capture_unavailable' });
    expect(text).not.toMatch(/LEAK|Buyer|998901/);
    // A ZodError from the model's output is a server-side failure, never the caller's 400.
    mocks.voice.mockRejectedValue(new z.ZodError([]));
    expect((await fetch(`${base}/v1/capture/voice`, { method: 'POST', body: form({ audio: audio() }) })).status).toBe(502);
  });
});
