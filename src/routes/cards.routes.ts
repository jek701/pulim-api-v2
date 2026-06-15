import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { enforceLimit } from '../middleware/enforceLimit';
import { asyncHandler } from '../utils/asyncHandler';
import { cardCreateSchema, cardUpdateSchema, refillSchema } from '../domain/schemas';
import { refillCreditCard } from '../services/card.service';

const router = Router();
const cards = crudControllers(userScopedRepo('cards'), { sort: { field: 'createdAt', dir: 'desc' } });

router.get('/', cards.list);
router.post('/', validate(cardCreateSchema), enforceLimit('cards'), cards.create);
router.post(
  '/refill',
  validate(refillSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await refillCreditCard(req.uid, req.body));
  }),
);
router.patch('/:id', validate(cardUpdateSchema), cards.update);
router.delete('/:id', cards.remove);

export const cardsRouter = router;
