import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import { debtCreateSchema, debtUpdateSchema, payDebtSchema } from '../domain/schemas';
import {
  listDebts,
  createDebt,
  updateDebt,
  deleteDebt,
  payDebt,
} from '../controllers/debts.controller';

const router = Router();

router.get('/', listDebts);
router.post('/', validate(debtCreateSchema), requirePremium('debts_create'), createDebt);
router.patch('/:id', validate(debtUpdateSchema), updateDebt);
router.post('/:id/pay', validate(payDebtSchema), payDebt);
router.delete('/:id', deleteDebt);

export const debtsRouter = router;
