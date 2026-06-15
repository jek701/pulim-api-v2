import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import { asyncHandler } from '../utils/asyncHandler';
import { savingsGoalCreateSchema, contributeSchema } from '../domain/schemas';
import { contribute } from '../services/savings.service';

const router = Router();
const goals = crudControllers(userScopedRepo('savingsGoals'), {
  sort: { field: 'deadline', dir: 'asc' },
  createDefaults: { savedAmount: 0 },
});

router.get('/', goals.list);
router.post('/', validate(savingsGoalCreateSchema), requirePremium('savings_create'), goals.create);
router.post(
  '/:id/contribute',
  validate(contributeSchema),
  asyncHandler(async (req, res) => {
    res.json(await contribute(req.uid, String(req.params.id), req.body.amount, req.body.accountId));
  }),
);
router.delete('/:id', goals.remove);

export const savingsGoalsRouter = router;
