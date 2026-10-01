import { db } from '../config/firebase';
import type { DecodedToken } from '../config/firebase';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../domain/defaultCategories';
import { deriveAuthMetadata } from '../domain/authMetadata';
import { profileRef, getProfile } from '../repositories/profile.repository';
import { getTrialBlockCode, TRIAL_MS } from '../domain/trial';
import { AppError } from '../utils/AppError';
import { ensureNotificationDefaults } from '../notifications/settings';
import { queueTrialStarted } from '../notifications/queue.repository';

/**
 * Starts the user's one-time trial. The transaction makes concurrent requests
 * safe: after Firestore retries, only the first request can grant access.
 */
export async function startTrial(uid: string) {
  const ref = profileRef(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw AppError.notFound('Profile not found.');
    const data = snap.data();
    const now = Date.now();
    const blocked = getTrialBlockCode(data, now);
    if (blocked) {
      throw new AppError(409, blocked, blocked === 'PREMIUM_ALREADY_ACTIVE'
        ? 'Premium is already active.'
        : blocked === 'TRIAL_ALREADY_USED'
          ? 'The Premium trial has already been used.'
          : 'This account is not eligible for a Premium trial.');
    }
    tx.update(ref, {
      isPremium: true,
      'subscription.tier': 'premium',
      'subscription.isTrial': true,
      'subscription.trialGrantedAt': now,
      'subscription.premiumUntil': now + TRIAL_MS,
      'subscription.source': 'trial',
      updatedAt: now,
    });
  });
  void queueTrialStarted(uid).catch(() => undefined);
  return getProfile(uid);
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
 * Idempotent post-login bootstrap: seed categories and sync auth metadata.
 * Trial activation is an explicit user action. Safe to call on every login.
 */
export async function bootstrap(uid: string, claims: DecodedToken) {
  await seedDefaultCategories(uid);
  await syncAuthMetadata(uid, claims);
  await ensureNotificationDefaults(uid);
  return getProfile(uid);
}
