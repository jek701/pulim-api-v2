import { asyncHandler } from '../utils/asyncHandler';
import { documentKey, queryTable, readDocument } from '../db/documents';
import { isValidClientId } from '../domain/clientId';
import { AppError } from '../utils/AppError';
import { FREE_LIMITS } from '../domain/entitlements';
import {
  getIsPremium,
  countOwned,
  freeLimitFor,
  type CountedResource,
} from '../services/entitlement.service';

/** Tables of the resources whose create accepts an offline client id. */
const CLIENT_ID_TABLES: Partial<Record<CountedResource, string>> = {
  cards: 'cards',
  subscriptions: 'subscriptions',
};

/** True when the request replays a create of a document the caller already owns. */
async function isOwnReplay(uid: string, resource: CountedResource, body: unknown): Promise<boolean> {
  const table = CLIENT_ID_TABLES[resource];
  const id = (body as { id?: unknown } | undefined)?.id;
  if (!table || typeof id !== 'string' || !isValidClientId(id)) return false;
  const snap = await readDocument(documentKey(queryTable(table), id));
  return snap.exists && snap.data?.userId === uid;
}

/**
 * Block creation past the free-tier count for a resource. Premium bypasses.
 * For cards, free users are additionally restricted to debit cards.
 */
export const enforceLimit = (resource: CountedResource) =>
  asyncHandler(async (req, _res, next) => {
    // An offline replay of an existing own document creates nothing: never limit it.
    if (await isOwnReplay(req.uid, resource, req.body)) {
      next();
      return;
    }
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
