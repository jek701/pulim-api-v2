import { documentKey, queryTable, readDocument, runSqlTransaction } from '../db/documents';
import { asyncHandler } from '../utils/asyncHandler';
const settingsRef = (uid: string) => documentKey(queryTable('userSettings'), uid);
// Mirrors the frontend default in `useUserSettings.ts`.
const DEFAULTS = { plannedExpenseVisibility: 'this_month' as const };
export const getSettings = asyncHandler(async (req, res) => {
  const snap = await readDocument(settingsRef(req.uid));
  res.json(snap.exists ? { id: snap.id, ...snap.data } : { id: req.uid, ...DEFAULTS });
});
export const patchSettings = asyncHandler(async (req, res) => {
  const data = await runSqlTransaction(async (tx) => {
    const ref = settingsRef(req.uid);
    const snap = await tx.read(ref);
    const incoming = { ...req.body };
    if (
      incoming.planSettings &&
      snap.data?.planSettings &&
      incoming.planSettings.updatedAt < snap.data.planSettings.updatedAt
    )
      delete incoming.planSettings;
    // Replace the nested object, rather than recursively merging removed optional keys.
    const stored = { ...snap.data, ...incoming, updatedAt: Date.now() };
    tx.save(ref, stored);
    return stored;
  });
  res.json({ id: req.uid, ...data });
});
