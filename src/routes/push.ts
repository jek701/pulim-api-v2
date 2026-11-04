import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { registerDevice, unregisterDevice } from '../push/devices.repository';
import { deviceTokenSchema, registerDeviceSchema } from '../push/schemas';

const router = Router();
router.post(
  '/devices',
  validate(registerDeviceSchema),
  asyncHandler(async (req, res) => {
    const device = await registerDevice(req.uid, req.body);
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
