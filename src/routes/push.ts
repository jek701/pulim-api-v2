import { kickPushPlanning } from '../push/kick';
import { AppError } from '../utils/AppError';
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { registerDevice, unregisterDevice } from '../push/devices.repository';
import { deviceTokenSchema, registerDeviceSchema } from '../push/schemas';
import { pushAvailable } from '../push/availability';
import { env } from '../config/env';

const router = Router();
router.use((req, _res, next) => {
  if (req.claims?.firebase?.sign_in_provider === 'anonymous') {
    next(AppError.unauthorized('Sign in to register push notifications.'));
    return;
  }
  next();
});
router.post(
  '/devices',
  validate(registerDeviceSchema),
  asyncHandler(async (req, res) => {
    if (req.body.bundleId !== env.APNS_BUNDLE_ID) {
      throw AppError.badRequest('The bundleId must match the configured APNs application.');
    }
    if (!await pushAvailable()) {
      throw new AppError(503, 'PUSH_UNAVAILABLE', 'Push notifications are not enabled or the provider/device registry is unavailable.');
    }
    const device = await registerDevice(req.uid, req.body);
    kickPushPlanning(req.uid);
    res.json({
      device: {
        id: device.id,
        environment: device.environment,
        enabled: device.disabledAt === null,
      },
    });
  }),
);
router.delete(
  '/devices/:token',
  validate(z.object({ token: deviceTokenSchema }), 'params'),
  asyncHandler(async (req, res) => {
    await unregisterDevice(req.uid, String(req.params.token));
    res.status(204).end();
  }),
);
export const pushRouter = router;
