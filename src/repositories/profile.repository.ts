import { documentKey, queryTable, readDocument, saveDocument } from '../db/documents';
import type { UserProfile } from '../domain/types';
const COLLECTION = 'profiles';
export const profileRef = (uid: string) => documentKey(queryTable(COLLECTION), uid);
export async function getProfile(uid: string): Promise<
  | (UserProfile & {
      id: string;
    })
  | null
> {
  const snap = await readDocument(profileRef(uid));
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data as UserProfile) };
}
export async function profileExists(uid: string): Promise<boolean> {
  return (await readDocument(profileRef(uid))).exists;
}
/** Shallow merge into the profile, always stamping `updatedAt`. */
export async function mergeProfile(uid: string, patch: Record<string, unknown>): Promise<void> {
  await saveDocument(profileRef(uid), { ...patch, updatedAt: Date.now() }, { merge: true });
}
