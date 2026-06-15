import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import { budgetSetSchema } from '../domain/schemas';
import { listBudgets, setBudget, deleteBudget } from '../controllers/budget.controller';

const router = Router();

router.get('/', listBudgets);
router.put('/:categoryId', validate(budgetSetSchema), requirePremium('budgets'), setBudget);
router.delete('/:categoryId', deleteBudget);

export const budgetsRouter = router;
