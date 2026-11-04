import { Router } from 'express';
import { notificationSettingsPatchSchema } from '../domain/schemas';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { patchNotificationSettings } from '../notifications/settings';

import { pushActive } from '../push/devices.repository';

const router = Router();

router.patch(
  '/',
  validate(notificationSettingsPatchSchema),
  asyncHandler(async (req, res) => {
    const settings = await patchNotificationSettings(req.uid, req.body);
    res.json({ ...settings, pushActive: await pushActive(req.uid) });
  }),
);

export const notificationSettingsRouter = router;
