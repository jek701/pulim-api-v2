import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { crudControllers } from '../controllers/crud';
import { validate } from '../middleware/validate';
import { subcategoryCreateSchema } from '../domain/schemas';

const router = Router();
const subcategories = crudControllers(userScopedRepo('subcategories'));

router.get('/', subcategories.list);
router.post('/', validate(subcategoryCreateSchema), subcategories.create);
router.delete('/:id', subcategories.remove);

export const subcategoriesRouter = router;
