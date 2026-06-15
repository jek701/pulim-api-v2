import { db } from '../config/firebase';
import type { UserProfile } from '../domain/types';

const COLLECTION = 'profiles';

export const profileRef = (uid: string) => db.collection(COLLECTION).doc(uid);

export async function getProfile(uid: string): Promise<(UserProfile & { id: string }) | null> {
  const snap = await profileRef(uid).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as UserProfile) };
}

export async function profileExists(uid: string): Promise<boolean> {
  return (await profileRef(uid).get()).exists;
}

/** Shallow merge into the profile, always stamping `updatedAt`. */
export async function mergeProfile(uid: string, patch: Record<string, unknown>): Promise<void> {
  await profileRef(uid).set({ ...patch, updatedAt: Date.now() }, { merge: true });
}
