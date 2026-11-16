import { documentKey, queryTable, runSqlTransaction } from '../db/documents';
import { internalHmac } from '../middleware/internalHmac';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
const router = Router();
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
router.post(
  '/',
  internalHmac({ secret: () => env.PULIM_PAYMENT_INTERNAL_SECRET, scheme: 'billing' }),
  asyncHandler(async (req, res) => {
    const eventIdHeader = req.header('x-pulim-event-id');
    const event = eventSchema.parse(req.body);
    if (event.eventId !== eventIdHeader) {
      throw AppError.unauthorized('Billing event identity mismatch.');
    }
    const occurredAt = Date.parse(event.occurredAt);
    const validFrom = event.validFrom ? Date.parse(event.validFrom) : null;
    const validUntil = event.validUntil ? Date.parse(event.validUntil) : null;
    const isPremium = event.tier === 'premium' && validUntil !== null && validUntil > Date.now();
    if (event.tier === 'premium' && (!validFrom || !validUntil || validUntil <= validFrom)) {
      throw AppError.badRequest('Invalid paid entitlement period.');
    }
    const eventRef = documentKey(queryTable('billingEvents'), event.eventId);
    const profileRef = documentKey(queryTable('profiles'), event.userId);
    const applied = await runSqlTransaction(async (transaction) => {
      const [existingEvent, profile] = await Promise.all([
        transaction.read(eventRef),
        transaction.read(profileRef),
      ]);
      if (existingEvent.exists) return false;
      // Account deletion is final. A late payment outbox retry is acknowledged without writes.
      if (!profile.exists || profile.data.deletionRequestedAt) return false;
      const profileData = profile.data as {
        subscription?: {
          billingVersion?: unknown;
        };
      };
      const currentVersion = profileData.subscription?.billingVersion;
      const shouldApply = typeof currentVersion !== 'number' || event.version > currentVersion;
      if (shouldApply) {
        transaction.save(
          profileRef,
          {
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
          },
          { merge: true },
        );
      }
      transaction.insert(eventRef, {
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
    req.log.info(
      {
        eventId: event.eventId,
        eventVersion: event.version,
        orderId: event.orderId,
        userId: event.userId,
        tier: event.tier,
        validUntil,
        applied,
      },
      'Billing entitlement event processed',
    );
    res.status(204).end();
  }),
);
export const billingInternalRouter = router;
