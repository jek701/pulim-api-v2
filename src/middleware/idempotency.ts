import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { sql } from 'kysely';
import { database } from '../db/database';
import {
  Timestamp,
  documentKey,
  insertIdempotencyMarker,
  patchDocument,
  readDocument,
  type DocumentData,
} from '../db/documents';
import {
  IdempotencyConflict,
  idempotencyStorage,
  type IdempotencyContext,
} from '../db/idempotencyContext';
import { isSyncEnabled } from '../db/syncIndex';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const IDEMPOTENCY_TTL_MS = 30 * 86_400_000;
/**
 * Endpoints whose whole effect is ONE SQL transaction. Only these honour the key: the marker
 * commits atomically with the effect, so a stored marker always means a complete effect.
 * Everything else (multi-step handlers such as PATCH /profile, bootstrap, clear-all, household
 * invites, AI) ignores the header; their clients must retry them as naturally idempotent.
 * Tuple: [method, path relative to /v1, status of a successful response].
 */
const SEG = '[^/]+';
const HONOURED: Array<[string, RegExp, number]> = [
  ['POST', /^\/transactions\/?$/, 201],
  ['POST', /^\/transactions\/transfer\/?$/, 201],
  ['POST', new RegExp(`^/transactions/${SEG}/return/?$`), 201],
  ['PATCH', new RegExp(`^/transactions/${SEG}(/transfer|/return)?/?$`), 200],
  ['DELETE', new RegExp(`^/transactions/${SEG}/?$`), 204],
  ['POST', /^\/cards\/?$/, 201],
  ['POST', /^\/cards\/refill\/?$/, 201],
  ['PATCH', new RegExp(`^/cards/${SEG}/?$`), 200],
  ['DELETE', new RegExp(`^/cards/${SEG}/?$`), 204],
  ['POST', /^\/(categories|subcategories|savings-goals|debts|deposits|subscriptions|planned-expenses)\/?$/, 201],
  ['PATCH', new RegExp(`^/(categories|subcategories|savings-goals|debts|subscriptions|planned-expenses)/${SEG}/?$`), 200],
  ['DELETE', new RegExp(`^/(categories|subcategories|savings-goals|debts|deposits|subscriptions|planned-expenses)/${SEG}/?$`), 204],
  ['POST', new RegExp(`^/(savings-goals/${SEG}/contribute|debts/${SEG}/pay|subscriptions/${SEG}/pay)/?$`), 200],
  ['POST', new RegExp(`^/deposits/${SEG}/(collect-interest|close|replenish|withdraw)/?$`), 200],
  ['PUT', new RegExp(`^/budgets/${SEG}/?$`), 200],
  ['DELETE', new RegExp(`^/budgets/${SEG}/?$`), 204],
  ['PATCH', /^\/settings\/?$/, 200],
];
export function honouredStatus(method: string, path: string): number | undefined {
  return HONOURED.find(([m, pattern]) => m === method && pattern.test(path))?.[2];
}
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
  // The effect committed but the final response was never stored (crash, oversized body).
  // Answer success with whatever the transaction returned (possibly nothing: the client
  // then relies on the delta feed) and flag it.
  res.setHeader('Idempotent-Replay-Partial', 'true');
  send(
    res,
    typeof marker.successStatus === 'number' ? marker.successStatus : fallbackStatus(ctx.method),
    marker.effect,
  );
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
  try {
    if (ctx.claimed) {
      const copy = snapshot(body);
      if (!copy.ok) return; // keep the effect fallback rather than a truncated body
      const completed: DocumentData = { status, completedAt: Date.now() };
      if (copy.value !== undefined) completed.body = copy.value;
      await patchDocument(markerRef(ctx), completed);
      return;
    }
    // No transaction carried the marker (a replayed own-id create, a no-op): store the response.
    const copy = snapshot(body);
    if (!copy.ok) return;
    await insertIdempotencyMarker(database(), ctx, { status, body: copy.value });
  } catch (error) {
    if (error instanceof IdempotencyConflict) return;
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
  if (header === undefined || !isSyncEnabled()) {
    next();
    return;
  }
  const successStatus = honouredStatus(req.method, req.path);
  if (successStatus === undefined) {
    // Not a single-transaction mutation (or not a mutation): the key is ignored, visibly.
    if (req.method !== 'GET' && req.method !== 'HEAD') res.setHeader('Idempotency-Ignored', 'true');
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
    successStatus,
    claimed: false,
  };
  const existing = await readDocument(markerRef(ctx));
  if (existing.exists) {
    const expiresAt = existing.data.expiresAt;
    const expired = expiresAt instanceof Timestamp && expiresAt.toMillis() < Date.now();
    if (expired) {
      // Free the key atomically; a concurrent reuse then loses on the primary key.
      await sql`DELETE FROM idempotency_keys WHERE id = ${Buffer.from(ctx.markerId)} AND expires_at_ms < ${Date.now()}`.execute(
        database(),
      );
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
