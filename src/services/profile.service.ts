import {
  documentKey,
  filterQuery,
  limitQuery,
  queryTable,
  readDocument,
  patchDocument,
  runSqlTransaction,
  saveDocument,
  writeBatch,
} from '../db/documents';
import type { DecodedToken } from '../config/firebaseAuth';
import { categorySeeds, type OnboardingCategorySelection } from '../domain/defaultCategories';
import { deriveAuthMetadata } from '../domain/authMetadata';
import { profileRef, getProfile } from '../repositories/profile.repository';
import { getTrialBlockCode, TRIAL_MS } from '../domain/trial';
import { AppError } from '../utils/AppError';
import { ensureNotificationDefaults, notificationDefaults } from '../notifications/settings';
import { queueTrialStarted } from '../notifications/queue.repository';
/**
 * Starts the user's one-time trial. The transaction makes concurrent requests
 * safe: after Firestore retries, only the first request can grant access.
 */
export async function startTrial(uid: string) {
  const ref = profileRef(uid);
  await runSqlTransaction(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.exists) throw AppError.notFound('Profile not found.');
    const data = snap.data;
    const now = Date.now();
    const blocked = getTrialBlockCode(data, now);
    if (blocked) {
      throw new AppError(
        409,
        blocked,
        blocked === 'PREMIUM_ALREADY_ACTIVE'
          ? 'Premium is already active.'
          : blocked === 'TRIAL_ALREADY_USED'
            ? 'The Premium trial has already been used.'
            : 'This account is not eligible for a Premium trial.',
      );
    }
    tx.patch(ref, {
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
/**
 * Seed categories for a user whose categories collection is empty (otherwise a no-op, also
 * for a supplied selection). Without `selection`: every default. With it: only the chosen
 * defaults plus the custom ones. All ids are deterministic and writes merge, so retries and
 * concurrent bootstraps converge on the same documents.
 */
export async function seedDefaultCategories(
  uid: string,
  selection?: OnboardingCategorySelection,
): Promise<void> {
  const existing = await readDocument(
    limitQuery(filterQuery(queryTable('categories'), 'userId', '==', uid), 1),
  );
  if (!existing.empty) return;
  const createdAt = Date.now();
  const batch = writeBatch();
  for (const seed of categorySeeds(uid, createdAt, selection)) {
    batch.save(documentKey(queryTable('categories'), seed.id), seed.data, { merge: true });
  }
  await batch.commit();
}
/** Persist auth metadata derived from the verified ID token claims. */
export async function syncAuthMetadata(uid: string, claims: DecodedToken, creating = false): Promise<void> {
  const meta = deriveAuthMetadata(claims);
  if (creating) {
    await saveDocument(profileRef(uid), { ...meta, createdAt: Date.now(), updatedAt: Date.now() }, { merge: true });
  } else {
    // A bootstrap already in flight when deletion started may only update its existing row.
    await patchDocument(profileRef(uid), { ...meta, updatedAt: Date.now() });
  }
}
/**
 * Idempotent post-login bootstrap: seed categories (optionally the onboarding selection, the
 * only way a free user gets custom categories) and sync auth metadata.
 * Trial activation is an explicit user action. Safe to call on every login.
 */
export async function bootstrap(
  uid: string,
  claims: DecodedToken,
  selection?: OnboardingCategorySelection,
) {
  const current = await getProfile(uid);
  if (current?.deletionRequestedAt)
    throw AppError.conflict('ACCOUNT_DELETION_IN_PROGRESS', 'Account deletion is in progress.');
  await syncAuthMetadata(uid, claims, !current);
  await seedDefaultCategories(uid, selection);
  await ensureNotificationDefaults(uid);
  return getProfile(uid);
}

/** Runtime device status is deliberately absent from the stored/synced profile. */
export async function profileWithPushStatus(uid: string) {
  const profile = await getProfile(uid);
  if (!profile) return null;
  const { pushActive } = await import('../push/devices.repository');
  const { normalizePushSettings } = await import('../push/settings');
  const defaults = notificationDefaults(profile);
  return {
    ...profile,
    notifications: {
      ...defaults,
      ...profile.notifications,
      telegram: { ...defaults.telegram, ...profile.notifications?.telegram },
      ...normalizePushSettings(profile.notifications, profile.timezone),
      pushActive: await pushActive(uid),
    },
  };
}
