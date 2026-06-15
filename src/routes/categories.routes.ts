import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { requirePremium } from '../middleware/requirePremium';
import { categoryCreateSchema } from '../domain/schemas';

const router = Router();
const categories = crudControllers(userScopedRepo('categories'));

router.get('/', categories.list);
router.post('/', validate(categoryCreateSchema), requirePremium('custom_categories'), categories.create);
router.delete('/:id', categories.remove);

export const categoriesRouter = router;
