import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import { depositCreateSchema, depositCloseSchema, depositAccountAmountSchema } from '../domain/schemas';
import {
  listDeposits,
  createDeposit,
  deleteDeposit,
  collectInterest,
  closeDeposit,
  replenishDeposit,
  withdrawDeposit,
} from '../controllers/deposits.controller';

const router = Router();

router.get('/', listDeposits);
router.post('/', validate(depositCreateSchema), requirePremium('deposits_create'), createDeposit);
router.post('/:id/collect-interest', collectInterest);
router.post('/:id/close', validate(depositCloseSchema), closeDeposit);
router.post('/:id/replenish', validate(depositAccountAmountSchema), replenishDeposit);
router.post('/:id/withdraw', validate(depositAccountAmountSchema), withdrawDeposit);
router.delete('/:id', deleteDeposit);

export const depositsRouter = router;
