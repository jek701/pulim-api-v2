import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import {
  Timestamp,
  documentKey,
  insertDocument,
  patchDocument,
  readDocument,
  saveDocument,
  type DocumentData,
} from '../db/documents';
import { idempotencyStorage, type IdempotencyContext } from '../db/idempotencyContext';
import { isSyncEnabled } from '../db/syncIndex';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const IDEMPOTENCY_TTL_MS = 30 * 86_400_000;
const MUTATIONS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_STORED_BODY = 200_000;
const REPLAY_WAIT_STEPS = 6;
const REPLAY_WAIT_MS = 500;

interface RequestState {
  ctx: IdempotencyContext;
  /** Once true, the response is being produced by a replay and must not be stored again. */
  finalized: boolean;
}
const states = new WeakMap<Response, RequestState>();

export const markerIdFor = (uid: string, key: string): string =>
  createHash('sha256').update(`${uid}:${key}`).digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}
export function requestHashOf(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([method, url, canonical(body ?? null)]))
    .digest('hex');
}

const markerRef = (ctx: IdempotencyContext) => documentKey('idempotencyKeys', ctx.markerId);

function snapshot(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > MAX_STORED_BODY) return { ok: false };
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function send(res: Response, status: number, body: unknown): void {
  const state = states.get(res);
  if (state) state.finalized = true;
  res.setHeader('Idempotent-Replayed', 'true');
  res.status(status);
  if (body === undefined || status === 204) res.end();
  else res.json(body);
}

function fallbackStatus(method: string): number {
  return method === 'DELETE' ? 204 : method === 'POST' ? 201 : 200;
}

/** Replay a stored marker. The effect is committed, so this must never run the request again. */
async function replay(res: Response, ctx: IdempotencyContext, first: DocumentData): Promise<void> {
  let marker = first;
  for (let step = 0; typeof marker.status !== 'number' && step < REPLAY_WAIT_STEPS; step++) {
    // The winner stores the final response just before replying; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, REPLAY_WAIT_MS));
    const again = await readDocument(markerRef(ctx));
    if (again.exists) marker = again.data;
  }
  if (typeof marker.status === 'number') {
    send(res, marker.status, marker.body);
    return;
  }
  // Crash window: the effect committed but the response was never stored. Answer with the
  // transaction result (same body in practice for every endpoint).
  send(res, fallbackStatus(ctx.method), marker.effect);
}

/** Called by the error handler when the transaction runner reports an existing marker. */
export async function handleIdempotencyConflict(req: Request, res: Response): Promise<void> {
  const state = states.get(res);
  if (!state) throw AppError.conflict('IDEMPOTENCY_CONFLICT', 'Retry the request.');
  const stored = await readDocument(markerRef(state.ctx));
  if (!stored.exists) throw AppError.conflict('IDEMPOTENCY_CONFLICT', 'Retry the request.');
  if (stored.data.requestHash !== state.ctx.requestHash) throw reused();
  await replay(res, state.ctx, stored.data);
}

const reused = () =>
  new AppError(
    422,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used with a different request.',
  );

async function persistResponse(ctx: IdempotencyContext, status: number, body: unknown): Promise<void> {
  const copy = snapshot(body);
  if (!copy.ok) return; // keep the effect fallback rather than a truncated body
  const completed: DocumentData = { status, completedAt: Date.now() };
  if (copy.value !== undefined) completed.body = copy.value;
  try {
    if (ctx.claimed) {
      await patchDocument(markerRef(ctx), completed);
      return;
    }
    // No transaction carried the marker (read-style endpoint): store the response itself.
    const now = Date.now();
    const data: DocumentData = {
      userId: ctx.uid,
      key: ctx.key,
      method: ctx.method,
      path: ctx.path,
      requestHash: ctx.requestHash,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + IDEMPOTENCY_TTL_MS),
      ...completed,
    };
    if (ctx.overwrite) await saveDocument(markerRef(ctx), data);
    else await insertDocument(markerRef(ctx), data);
  } catch (error) {
    // The effect is already committed; never fail the response because of bookkeeping.
    logger.warn({ err: error }, 'idempotency.persist.failed');
  }
}

/**
 * Honours `Idempotency-Key` on /v1 mutations. The marker itself is written by
 * `runSqlTransaction` in the same SQL transaction as the effect (see db/documents.ts).
 */
export const idempotency: RequestHandler = asyncHandler(async (req, res, next) => {
  const header = req.header(IDEMPOTENCY_HEADER);
  if (header === undefined || !MUTATIONS.has(req.method) || !isSyncEnabled()) {
    next();
    return;
  }
  // SSE chat is not replayable.
  if (/^\/ai\/chat\/?$/.test(req.path)) {
    next();
    return;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must match ^[A-Za-z0-9_-]{16,128}$.',
    );
  }
  const ctx: IdempotencyContext = {
    uid: req.uid,
    markerId: markerIdFor(req.uid, header),
    key: header,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    requestHash: requestHashOf(req.method, req.originalUrl, req.body),
    overwrite: false,
    claimed: false,
  };
  const existing = await readDocument(markerRef(ctx));
  if (existing.exists) {
    const expiresAt = existing.data.expiresAt;
    const expired = expiresAt instanceof Timestamp && expiresAt.toMillis() < Date.now();
    if (expired) {
      ctx.overwrite = true;
    } else {
      if (existing.data.requestHash !== ctx.requestHash) throw reused();
      await replay(res, ctx, existing.data);
      return;
    }
  }
  const state: RequestState = { ctx, finalized: false };
  states.set(res, state);
  installResponseCapture(res, state);
  idempotencyStorage.run(ctx, () => next());
});

/** Persist the final 2xx response before the client can see it. */
function installResponseCapture(res: Response, state: RequestState): void {
  const json = res.json.bind(res);
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  const capture = (body: unknown, release: () => void): boolean => {
    if (state.finalized || res.headersSent || res.statusCode < 200 || res.statusCode >= 300)
      return false;
    state.finalized = true;
    void persistResponse(state.ctx, res.statusCode, body).finally(() => {
      try {
        release();
      } catch (error) {
        logger.error({ err: error }, 'idempotency.respond.failed');
      }
    });
    return true;
  };
  res.json = ((body?: unknown) => {
    if (!capture(body, () => json(body))) return json(body);
    return res;
  }) as Response['json'];
  res.end = ((...args: unknown[]) => {
    if (!capture(undefined, () => end(...args))) return end(...args);
    return res;
  }) as Response['end'];
}
