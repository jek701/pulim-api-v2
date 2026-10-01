import { Router } from 'express';
import { notificationSettingsPatchSchema } from '../domain/schemas';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { setNotificationsEnabled } from '../notifications/settings';

const router = Router();

router.patch('/', validate(notificationSettingsPatchSchema), asyncHandler(async (req, res) => {
  res.json(await setNotificationsEnabled(req.uid, req.body.enabled));
}));

export const notificationSettingsRouter = router;
