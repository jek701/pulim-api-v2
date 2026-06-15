import { Router } from 'express';
import { validate } from '../middleware/validate';
import { settingsPatchSchema } from '../domain/schemas';
import { getSettings, patchSettings } from '../controllers/settings.controller';

const router = Router();

router.get('/', getSettings);
router.patch('/', validate(settingsPatchSchema), patchSettings);

export const settingsRouter = router;
