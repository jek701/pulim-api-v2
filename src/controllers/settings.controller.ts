import { documentKey, queryTable, readDocument, saveDocument } from '../db/documents';
import { asyncHandler } from '../utils/asyncHandler';
const settingsRef = (uid: string) => documentKey(queryTable('userSettings'), uid);
// Mirrors the frontend default in `useUserSettings.ts`.
const DEFAULTS = { plannedExpenseVisibility: 'this_month' as const };
export const getSettings = asyncHandler(async (req, res) => {
  const snap = await readDocument(settingsRef(req.uid));
  res.json(snap.exists ? { id: snap.id, ...snap.data } : { id: req.uid, ...DEFAULTS });
});
export const patchSettings = asyncHandler(async (req, res) => {
  await saveDocument(settingsRef(req.uid), { ...req.body, updatedAt: Date.now() }, { merge: true });
  const snap = await readDocument(settingsRef(req.uid));
  res.json({ id: snap.id, ...snap.data });
});
