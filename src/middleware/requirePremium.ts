import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { canUse, type FeatureKey } from '../domain/entitlements';
import { getIsPremium } from '../services/entitlement.service';

/**
 * Gate a route behind a premium-only feature (the always-blocked features in
 * `canUse`). Count-limited features (cards, subscriptions) use `enforceLimit`.
 */
export const requirePremium = (feature: FeatureKey) =>
  asyncHandler(async (req, _res, next) => {
    const isPremium = await getIsPremium(req.uid);
    if (canUse(feature, { isPremium })) {
      next();
      return;
    }
    throw AppError.forbidden('PREMIUM_REQUIRED', `This feature requires Premium (${feature}).`);
  });
