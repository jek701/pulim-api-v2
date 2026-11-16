import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/AppError';

export const INTERNAL_CLOCK_SKEW_MS = 5 * 60_000;
export function internalSignature(
  secret: string,
  timestamp: string,
  raw: Buffer | string,
  requestId?: string,
): string {
  return createHmac('sha256', secret)
    .update(requestId === undefined ? `${timestamp}.` : `${timestamp}.${requestId}.`)
    .update(raw)
    .digest('hex');
}
function secureHexEqual(expected: string, received: string): boolean {
  return (
    /^[a-f0-9]{64}$/i.test(received) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
  );
}

/** Billing keeps its original signing string and durable event-id dedupe. */
export function internalHmac(options: {
  secret: () => string | undefined;
  scheme: 'billing' | 'crm';
}): RequestHandler {
  // Auth replay cache only; business idempotency is durable in the notifications table.
  // Billing has no request-id replay cache and remains unchanged.
  const seen = new Map<string, number>();
  return (req, res, next) => {
    try {
      const secret = options.secret();
      if (!secret) {
        if (options.scheme === 'crm') {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
          return;
        }
        throw new AppError(
          503,
          'BILLING_NOT_CONFIGURED',
          'Billing event receiver is not configured.',
        );
      }
      const timestamp = req.header('x-pulim-timestamp');
      const signature = req.header('x-pulim-signature');
      const id = req.header(options.scheme === 'crm' ? 'x-pulim-request-id' : 'x-pulim-event-id');
      const raw = options.scheme === 'crm' && req.method === 'GET' ? Buffer.alloc(0) : req.rawBody;
      if (!timestamp || !signature || !id || !raw)
        throw AppError.unauthorized(
          options.scheme === 'billing'
            ? 'Missing billing event authentication.'
            : 'Missing internal authentication.',
        );
      const time = Number(timestamp);
      const now = Date.now();
      if (!Number.isSafeInteger(time) || Math.abs(now - time) > INTERNAL_CLOCK_SKEW_MS)
        throw AppError.unauthorized(
          options.scheme === 'billing'
            ? 'Billing event timestamp is invalid or stale.'
            : 'Internal timestamp is invalid or stale.',
        );
      if (options.scheme === 'crm' && !z.string().uuid().safeParse(id).success)
        throw AppError.unauthorized('Invalid internal request identity.');
      if (
        !secureHexEqual(
          internalSignature(secret, timestamp, raw, options.scheme === 'crm' ? id : undefined),
          signature,
        )
      )
        throw AppError.unauthorized(
          options.scheme === 'billing'
            ? 'Invalid billing event signature.'
            : 'Invalid internal signature.',
        );
      if (options.scheme === 'crm') {
        for (const [key, expires] of seen) {
          if (expires < now) seen.delete(key);
          else break;
        }
        if (seen.has(id)) throw AppError.unauthorized('Internal request replay.');
        // Refuse new ids at capacity instead of evicting still-valid replay protection.
        if (seen.size >= 100_000) throw new AppError(503, 'INTERNAL_AUTH_BUSY', 'Retry later.');
        seen.set(id, now + 2 * INTERNAL_CLOCK_SKEW_MS);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
