import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import type { RequestHandler } from 'express';
import { categoryCreateSchema, categoryUpdateSchema } from '../domain/schemas';

const router = Router();
const categories = crudControllers(userScopedRepo('categories'));

router.get('/', categories.list);
router.post('/', validate(categoryCreateSchema), requirePremium('custom_categories'), categories.create);
// Built-in categories (`${uid}__default__…`) are editable on the free plan, custom ones need Premium.
const premiumForCustom: RequestHandler = (req, res, next) => {
  if (String(req.params.id).startsWith(`${req.uid}__default__`)) next();
  else requirePremium('custom_categories')(req, res, next);
};
router.patch('/:id', validate(categoryUpdateSchema), premiumForCustom, categories.update);
router.delete('/:id', categories.remove);

export const categoriesRouter = router;
