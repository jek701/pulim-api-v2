import { Router } from 'express';
import { validate } from '../middleware/validate';
import { profilePatchSchema, homeWidgetsSchema } from '../domain/schemas';
import {
  postBootstrap,
  getProfileHandler,
  patchProfile,
  patchHomeWidgets,
  dismissTelegramLink,
} from '../controllers/profile.controller';

const router = Router();

router.post('/bootstrap', postBootstrap);
router.get('/', getProfileHandler);
router.patch('/', validate(profilePatchSchema), patchProfile);
router.patch('/home-widgets', validate(homeWidgetsSchema), patchHomeWidgets);
router.post('/telegram-link-dismissed', dismissTelegramLink);

export const profileRouter = router;
