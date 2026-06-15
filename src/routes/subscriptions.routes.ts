import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { enforceLimit } from '../middleware/enforceLimit';
import { asyncHandler } from '../utils/asyncHandler';
import { subscriptionCreateSchema, subscriptionUpdateSchema, accountOnlySchema } from '../domain/schemas';
import { paySubscription } from '../services/subscription.service';

const router = Router();
const subscriptions = crudControllers(userScopedRepo('subscriptions'), {
  sort: { field: 'nextBillingDate', dir: 'asc' },
});

router.get('/', subscriptions.list);
router.post('/', validate(subscriptionCreateSchema), enforceLimit('subscriptions'), subscriptions.create);
router.post(
  '/:id/pay',
  validate(accountOnlySchema),
  asyncHandler(async (req, res) => {
    res.json(await paySubscription(req.uid, String(req.params.id), req.body.accountId));
  }),
);
router.patch('/:id', validate(subscriptionUpdateSchema), subscriptions.update);
router.delete('/:id', subscriptions.remove);

export const subscriptionsRouter = router;
