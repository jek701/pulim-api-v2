import { asyncHandler } from '../utils/asyncHandler';
import { db } from '../config/firebase';
import { AppError } from '../utils/AppError';

// Budgets use a deterministic id so there is one budget per (user, category).
const budgetId = (uid: string, categoryId: string) => `${uid}_${categoryId}`;
const budgets = () => db.collection('budgets');

export const listBudgets = asyncHandler(async (req, res) => {
  const snap = await budgets().where('userId', '==', req.uid).get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});

export const setBudget = asyncHandler(async (req, res) => {
  const categoryId = String(req.params.categoryId);
  const id = budgetId(req.uid, categoryId);
  await budgets().doc(id).set(
    {
      categoryId,
      amount: req.body.amount,
      currency: req.body.currency,
      userId: req.uid,
      updatedAt: Date.now(),
    },
    { merge: true },
  );
  const snap = await budgets().doc(id).get();
  res.json({ id, ...snap.data() });
});

export const deleteBudget = asyncHandler(async (req, res) => {
  const id = budgetId(req.uid, String(req.params.categoryId));
  const snap = await budgets().doc(id).get();
  if (!snap.exists) throw AppError.notFound();
  await budgets().doc(id).delete();
  res.status(204).end();
});
