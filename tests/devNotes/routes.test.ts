import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDevNote } from '../../src/devNotes/devNotes.repository';
import { devNotesRouter } from '../../src/routes/devNotes.routes';
import { AppError } from '../../src/utils/AppError';

const db = vi.hoisted(() => ({
  saved: [] as { table: string; id: string; data: Record<string, unknown> }[],
  commit: vi.fn(async () => undefined),
}));
vi.mock('../../src/config/env', () => ({ devNotesUids: new Set(['owner']) }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }),
  documentKey: (query: { table: string }, id = 'note-1') => ({ table: query.table, id }),
  writeBatch: () => ({
    save: (key: { table: string; id: string }, data: Record<string, unknown>) => db.saved.push({ ...key, data }),
    commit: db.commit,
  }),
}));

describe('dev note creation', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.uid = req.get('x-test-uid') ?? 'owner';
      next();
    });
    app.use('/v1/dev-notes', devNotesRouter);
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
      res.status(error instanceof AppError ? error.statusCode : 500).json({ error: { code: error.code } });
    };
    app.use(errors);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/dev-notes`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    db.saved.length = 0;
    db.commit.mockClear();
  });

  const post = (body: unknown, uid = 'owner') => fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-uid': uid },
    body: JSON.stringify(body),
  });

  it('stores and returns iOS source, context and a separate screenshot', async () => {
    const context = { platform: 'ios', route: '/(tabs)/history', appVersion: '1.2.3', osVersion: '26.0', device: 'iPhone 17', appBuild: '42' };
    const screenshot = 'data:image/jpeg;base64,AAAA';
    const response = await post({ comment: ' Bigger button ', context, screenshot });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ source: 'ios', comment: 'Bigger button', context, hasScreenshot: true });
    expect(db.saved).toEqual([
      { table: 'devNotes', id: 'note-1', data: expect.objectContaining({ source: 'ios', context, userId: 'owner' }) },
      { table: 'devNoteScreenshots', id: 'note-1', data: expect.objectContaining({ dataUrl: screenshot, userId: 'owner' }) },
    ]);
    expect(db.commit).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}, { platform: 'web' }, { platform: 'telegram' }, { platform: 'android' }, { tab: 'home', url: 'https://example.test' }])(
    'keeps app source for context %j', async (context) => {
      const response = await post({ comment: 'Button', context });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ source: 'app', context: context ?? null });
      expect(db.saved[0].data.source).toBe('app');
    },
  );

  it('keeps bot-created notes as telegram', async () => {
    const note = await createDevNote({ uid: 'owner', source: 'telegram', comment: 'Bot idea' });
    expect(note).toMatchObject({ source: 'telegram', context: null });
    expect(db.saved[0].data.source).toBe('telegram');
  });

  it.each([
    { comment: 'x', source: 'ios' },
    { comment: 'x', context: { platform: 'desktop' } },
    { comment: 'x', context: { route: 'x'.repeat(301) } },
  ])('rejects invalid input without writing: %j', async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'VALIDATION_ERROR' } });
    expect(db.saved).toEqual([]);
    expect(db.commit).not.toHaveBeenCalled();
  });

  it('keeps iOS creation hidden from non-owners', async () => {
    const access = await fetch(`${base}/access`, { headers: { 'x-test-uid': 'other' } });
    expect(await access.json()).toEqual({ enabled: false });
    const response = await post({ comment: 'x', context: { platform: 'ios' } }, 'other');
    expect(response.status).toBe(404);
    expect(db.saved).toEqual([]);
  });
});
