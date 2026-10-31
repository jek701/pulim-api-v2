import { Router } from 'express';
import { guestImportSchema } from '../domain/guestImport';
import { importGuestSnapshot } from '../services/guestImport.service';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { profilePatchSchema, homeWidgetsSchema } from '../domain/schemas';
import {
  postBootstrap,
  postStartTrial,
  getProfileHandler,
  patchProfile,
  patchHomeWidgets,
  dismissTelegramLink,
} from '../controllers/profile.controller';

const router = Router();

router.post('/bootstrap', postBootstrap);
router.post(
  '/import-guest',
  validate(guestImportSchema),
  asyncHandler(async (req, res) => {
    res.json(await importGuestSnapshot(req.uid, req.body));
  }),
);
router.post('/trial/start', postStartTrial);
router.get('/', getProfileHandler);
router.patch('/', validate(profilePatchSchema), patchProfile);
router.patch('/home-widgets', validate(homeWidgetsSchema), patchHomeWidgets);
router.post('/telegram-link-dismissed', dismissTelegramLink);

export const profileRouter = router;
