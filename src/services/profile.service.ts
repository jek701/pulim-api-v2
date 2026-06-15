import { db } from '../config/firebase';
import type { DecodedToken } from '../config/firebase';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../domain/defaultCategories';
import { deriveAuthMetadata } from '../domain/authMetadata';
import { profileRef, getProfile } from '../repositories/profile.repository';

const TRIAL_MS = 30 * 86_400_000;

/**
 * First-touch trial: any user whose `isPremium` is still undefined gets a 30-day
 * Premium trial. Idempotent — never re-grants once the flag is set.
 */
export async function ensureTrial(uid: string): Promise<void> {
  const ref = profileRef(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (data && data.isPremium !== undefined) return;
    const now = Date.now();
    tx.set(
      ref,
      {
        isPremium: true,
        subscription: { tier: 'premium', isTrial: true, trialGrantedAt: now, premiumUntil: now + TRIAL_MS },
        updatedAt: now,
      },
      { merge: true },
    );
  });
}

/** Seed default categories for a user whose categories collection is empty. */
export async function seedDefaultCategories(uid: string): Promise<void> {
  const existing = await db.collection('categories').where('userId', '==', uid).limit(1).get();
  if (!existing.empty) return;

  const createdAt = Date.now();
  const batch = db.batch();
  for (const cat of DEFAULT_CATEGORIES) {
    const id = defaultCategoryId(uid, cat.type, cat.name);
    batch.set(db.collection('categories').doc(id), { ...cat, userId: uid, createdAt }, { merge: true });
  }
  await batch.commit();
}

/** Persist auth metadata derived from the verified ID token claims. */
export async function syncAuthMetadata(uid: string, claims: DecodedToken): Promise<void> {
  const meta = deriveAuthMetadata(claims);
  await profileRef(uid).set({ ...meta, updatedAt: Date.now() }, { merge: true });
}

/**
 * Idempotent post-login bootstrap: grant trial, seed categories, sync auth
 * metadata. Safe to call on every login. Returns the resulting profile.
 */
export async function bootstrap(uid: string, claims: DecodedToken) {
  await ensureTrial(uid);
  await seedDefaultCategories(uid);
  await syncAuthMetadata(uid, claims);
  return getProfile(uid);
}
