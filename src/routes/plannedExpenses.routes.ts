import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import { asyncHandler } from '../utils/asyncHandler';
import {
  plannedExpenseCreateSchema,
  plannedExpenseUpdateSchema,
  plannedExpenseSettleSchema,
  plannedExpenseLinkSchema,
  plannedExpenseUnlinkSchema,
} from '../domain/schemas';
import {
  linkPlannedExpense,
  settlePlannedExpense,
  unlinkPlannedExpense,
} from '../services/plannedExpense.service';

const router = Router();
const planned = crudControllers(userScopedRepo('planned_expenses'), {
  sort: { field: 'createdAt', dir: 'asc' },
});

router.get('/', planned.list);
router.post(
  '/',
  validate(plannedExpenseCreateSchema),
  requirePremium('planned_expenses'),
  planned.create,
);
router.post(
  '/:id/settle',
  validate(plannedExpenseSettleSchema),
  asyncHandler(async (req, res) => {
    res.json(await settlePlannedExpense(req.uid, String(req.params.id), req.body));
  }),
);
router.post(
  '/:id/link',
  validate(plannedExpenseLinkSchema),
  asyncHandler(async (req, res) => {
    res.json(await linkPlannedExpense(req.uid, String(req.params.id), req.body));
  }),
);
router.post(
  '/:id/unlink',
  validate(plannedExpenseUnlinkSchema),
  asyncHandler(async (req, res) => {
    res.json(await unlinkPlannedExpense(req.uid, String(req.params.id), req.body));
  }),
);
router.patch('/:id', validate(plannedExpenseUpdateSchema), planned.update);
router.delete('/:id', planned.remove);

export const plannedExpensesRouter = router;
