import {
  documentKey,
  filterQuery,
  queryTable,
  readDocument,
  removeDocument,
  saveDocument,
} from '../db/documents';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
// Budgets use a deterministic id so there is one budget per (user, category).
const budgetId = (uid: string, categoryId: string) => `${uid}_${categoryId}`;
const budgets = () => queryTable('budgets');
export const listBudgets = asyncHandler(async (req, res) => {
  const snap = await readDocument(filterQuery(budgets(), 'userId', '==', req.uid));
  res.json(snap.rows.map((d) => ({ id: d.id, ...d.data })));
});
export const setBudget = asyncHandler(async (req, res) => {
  const categoryId = String(req.params.categoryId);
  const id = budgetId(req.uid, categoryId);
  await saveDocument(
    documentKey(budgets(), id),
    {
      categoryId,
      amount: req.body.amount,
      currency: req.body.currency,
      userId: req.uid,
      updatedAt: Date.now(),
    },
    { merge: true },
  );
  const snap = await readDocument(documentKey(budgets(), id));
  res.json({ id, ...snap.data });
});
export const deleteBudget = asyncHandler(async (req, res) => {
  const id = budgetId(req.uid, String(req.params.categoryId));
  const snap = await readDocument(documentKey(budgets(), id));
  if (!snap.exists) throw AppError.notFound();
  await removeDocument(documentKey(budgets(), id));
  res.status(204).end();
});
