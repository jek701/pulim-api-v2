import { asyncHandler } from '../utils/asyncHandler';
import { db } from '../config/firebase';

const settingsRef = (uid: string) => db.collection('userSettings').doc(uid);

// Mirrors the frontend default in `useUserSettings.ts`.
const DEFAULTS = { plannedExpenseVisibility: 'this_month' as const };

export const getSettings = asyncHandler(async (req, res) => {
  const snap = await settingsRef(req.uid).get();
  res.json(snap.exists ? { id: snap.id, ...snap.data() } : { id: req.uid, ...DEFAULTS });
});

export const patchSettings = asyncHandler(async (req, res) => {
  await settingsRef(req.uid).set({ ...req.body, updatedAt: Date.now() }, { merge: true });
  const snap = await settingsRef(req.uid).get();
  res.json({ id: snap.id, ...snap.data() });
});
