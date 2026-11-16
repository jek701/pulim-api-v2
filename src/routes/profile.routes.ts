import { Router } from 'express';
import { validate } from '../middleware/validate';
import { bootstrapSchema, profilePatchSchema, homeWidgetsSchema } from '../domain/schemas';
import {
  putProfileConsent,
  postBootstrap,
  postStartTrial,
  getProfileHandler,
  patchProfile,
  patchHomeWidgets,
  dismissTelegramLink,
} from '../controllers/profile.controller';

const router = Router();

router.put('/consents/:type', putProfileConsent);
router.post('/bootstrap', validate(bootstrapSchema), postBootstrap);
router.post('/trial/start', postStartTrial);
router.get('/', getProfileHandler);
router.patch('/', validate(profilePatchSchema), patchProfile);
router.patch('/home-widgets', validate(homeWidgetsSchema), patchHomeWidgets);
router.post('/telegram-link-dismissed', dismissTelegramLink);

export const profileRouter = router;
