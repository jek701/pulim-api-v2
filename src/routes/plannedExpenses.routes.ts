import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import { plannedExpenseCreateSchema, plannedExpenseUpdateSchema } from '../domain/schemas';

const router = Router();
const planned = crudControllers(userScopedRepo('planned_expenses'), {
  sort: { field: 'createdAt', dir: 'asc' },
});

router.get('/', planned.list);
router.post('/', validate(plannedExpenseCreateSchema), requirePremium('planned_expenses'), planned.create);
router.patch('/:id', validate(plannedExpenseUpdateSchema), planned.update);
router.delete('/:id', planned.remove);

export const plannedExpensesRouter = router;
