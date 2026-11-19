import { documentKey, queryTable, runSqlTransaction } from '../db/documents';
import { internalHmac } from '../middleware/internalHmac';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { patchValue } from '../db/values';
const router = Router();
const eventSchema = z.object({
  eventId: z.string().uuid(),
  version: z.number().int().positive(),
  type: z.literal('billing.entitlement.updated'),
  occurredAt: z.string().datetime(),
  userId: z.string().min(1).max(128),
  orderId: z.string().uuid(),
  tier: z.enum(['premium', 'free']),
  source: z.enum(['atmos', 'apple', 'none']),
  isTrial: z.boolean(),
  autoRenew: z.boolean().optional(),
  planCode: z.string().optional(),
  environment: z.enum(['Sandbox', 'Production']).optional(),
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
      // Missing or scheduled-for-deletion accounts acknowledge payment retries without writes.
      if (!profile.exists || profile.data.deletionRequestedAt) return false;
      const profileData = profile.data as {
        subscription?: {
          billingVersion?: unknown;
          hadApplePremium?: boolean;
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
              isTrial: event.source === 'apple' ? event.isTrial : false,
              source: event.source,
              premiumUntil: validUntil,
              lastOrderId: event.orderId,
              billingVersion: event.version,
              ...(event.source === 'apple' ? {
                hadApplePremium: true,
                autoRenew: event.autoRenew ?? patchValue.delete(),
                planCode: event.planCode ?? patchValue.delete(),
              } : profileData.subscription?.hadApplePremium ? {
                autoRenew: patchValue.delete(),
                planCode: patchValue.delete(),
              } : {}),
            },
            updatedAt: Date.now(),
          },
          { merge: true },
        );
      } else if (event.source === 'apple' && !profileData.subscription?.hadApplePremium) {
        transaction.save(profileRef, { subscription: { hadApplePremium: true } }, { merge: true });
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
