import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/firebase';
import { env } from '../config/env';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';

const router = Router();
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const eventSchema = z.object({
  eventId: z.string().uuid(),
  version: z.number().int().positive(),
  type: z.literal('billing.entitlement.updated'),
  occurredAt: z.string().datetime(),
  userId: z.string().min(1).max(128),
  orderId: z.string().uuid(),
  tier: z.enum(['premium', 'free']),
  source: z.enum(['atmos', 'none']),
  isTrial: z.literal(false),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
  reason: z.enum(['refund']).optional(),
});

function secureHexEqual(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer);
}

router.post('/', asyncHandler(async (req, res) => {
  const secret = env.PULIM_PAYMENT_INTERNAL_SECRET;
  if (!secret) {
    throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Billing event receiver is not configured.');
  }

  const eventIdHeader = req.header('x-pulim-event-id');
  const timestampHeader = req.header('x-pulim-timestamp');
  const signatureHeader = req.header('x-pulim-signature');
  if (!eventIdHeader || !timestampHeader || !signatureHeader || !req.rawBody) {
    throw AppError.unauthorized('Missing billing event authentication.');
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    throw AppError.unauthorized('Billing event timestamp is invalid or stale.');
  }

  const rawBody = req.rawBody.toString('utf8');
  const expectedSignature = createHmac('sha256', secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');
  if (!secureHexEqual(expectedSignature, signatureHeader)) {
    throw AppError.unauthorized('Invalid billing event signature.');
  }

  const event = eventSchema.parse(req.body);
  if (event.eventId !== eventIdHeader) {
    throw AppError.unauthorized('Billing event identity mismatch.');
  }

  const occurredAt = Date.parse(event.occurredAt);
  const validFrom = event.validFrom ? Date.parse(event.validFrom) : null;
  const validUntil = event.validUntil ? Date.parse(event.validUntil) : null;
  const isPremium = event.tier === 'premium'
    && validUntil !== null
    && validUntil > Date.now();
  if (event.tier === 'premium' && (!validFrom || !validUntil || validUntil <= validFrom)) {
    throw AppError.badRequest('Invalid paid entitlement period.');
  }

  const eventRef = db.collection('billingEvents').doc(event.eventId);
  const profileRef = db.collection('profiles').doc(event.userId);
  const applied = await db.runTransaction(async (transaction) => {
    const [existingEvent, profile] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(profileRef),
    ]);
    if (existingEvent.exists) return false;
    if (!profile.exists) throw AppError.notFound('Billing user profile not found.');

    const profileData = profile.data() as {
      subscription?: { billingVersion?: unknown };
    };
    const currentVersion = profileData.subscription?.billingVersion;
    const shouldApply = typeof currentVersion !== 'number'
      || event.version > currentVersion;

    if (shouldApply) {
      transaction.set(profileRef, {
        isPremium,
        subscription: {
          tier: isPremium ? 'premium' : 'free',
          isTrial: false,
          source: event.source,
          premiumUntil: validUntil,
          lastOrderId: event.orderId,
          billingVersion: event.version,
        },
        updatedAt: Date.now(),
      }, { merge: true });
    }
    transaction.create(eventRef, {
      version: event.version,
      type: event.type,
      userId: event.userId,
      orderId: event.orderId,
      tier: event.tier,
      source: event.source,
      applied: shouldApply,
      validFrom,
      validUntil,
      reason: event.reason ?? null,
      occurredAt,
      receivedAt: Date.now(),
    });
    return shouldApply;
  });

  req.log.info({
    eventId: event.eventId,
    eventVersion: event.version,
    orderId: event.orderId,
    userId: event.userId,
    tier: event.tier,
    validUntil,
    applied,
  }, 'Billing entitlement event processed');
  res.status(204).end();
}));

export const billingInternalRouter = router;
