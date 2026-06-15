import { Router } from 'express';
import { validate } from '../middleware/validate';
import {
  transactionCreateSchema,
  transactionUpdateSchema,
  transferSchema,
  returnSchema,
} from '../domain/schemas';
import {
  listTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  clearAllTransactions,
  transfer,
  returnTransaction,
} from '../controllers/transactions.controller';

const router = Router();

router.get('/', listTransactions);
router.post('/', validate(transactionCreateSchema), createTransaction);
router.post('/transfer', validate(transferSchema), transfer);
router.delete('/', clearAllTransactions);
router.patch('/:id', validate(transactionUpdateSchema), updateTransaction);
router.post('/:id/return', validate(returnSchema), returnTransaction);
router.delete('/:id', deleteTransaction);

export const transactionsRouter = router;
