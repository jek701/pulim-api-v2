import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { FREE_LIMITS } from '../domain/entitlements';
import {
  getIsPremium,
  countOwned,
  freeLimitFor,
  type CountedResource,
} from '../services/entitlement.service';

/**
 * Block creation past the free-tier count for a resource. Premium bypasses.
 * For cards, free users are additionally restricted to debit cards.
 */
export const enforceLimit = (resource: CountedResource) =>
  asyncHandler(async (req, _res, next) => {
    if (await getIsPremium(req.uid)) {
      next();
      return;
    }

    const limit = freeLimitFor(resource);
    const count = await countOwned(req.uid, resource);
    if (count >= limit) {
      throw AppError.forbidden('LIMIT_REACHED', `The free plan allows ${limit} ${resource}.`);
    }

    if (resource === 'cards') {
      const cardType = (req.body as { cardType?: string }).cardType;
      if (cardType && !FREE_LIMITS.allowedCardTypes.includes(cardType as 'debit')) {
        throw AppError.forbidden('PREMIUM_REQUIRED', 'The free plan allows debit cards only.');
      }
    }
    next();
  });
