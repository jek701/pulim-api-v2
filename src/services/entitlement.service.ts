import { db } from '../config/firebase';
import { getProfile } from '../repositories/profile.repository';
import { FREE_LIMITS } from '../domain/entitlements';

export async function getIsPremium(uid: string): Promise<boolean> {
  const profile = await getProfile(uid);
  const premiumUntil = profile?.subscription?.premiumUntil;
  return profile?.isPremium === true
    && typeof premiumUntil === 'number'
    && premiumUntil > Date.now();
}

export type CountedResource = 'cards' | 'subscriptions' | 'aiChats';

const LIMIT_BY_RESOURCE: Record<CountedResource, number> = {
  cards: FREE_LIMITS.cards,
  subscriptions: FREE_LIMITS.subscriptions,
  aiChats: FREE_LIMITS.aiChats,
};

export function freeLimitFor(resource: CountedResource): number {
  return LIMIT_BY_RESOURCE[resource];
}

export async function countOwned(uid: string, collection: string): Promise<number> {
  const snap = await db.collection(collection).where('userId', '==', uid).count().get();
  return snap.data().count;
}
