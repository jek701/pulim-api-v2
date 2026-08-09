import { Router } from 'express';
import { validate } from '../middleware/validate';
import { phoneSendCodeSchema, phoneVerifyCodeSchema } from '../domain/schemas';
import { postSendPhoneCode, postVerifyPhoneCode } from '../controllers/phoneAuth.controller';

const router = Router();

// Public — the per-number cooldown / attempt limits live in phoneAuth.service.
router.post('/send-code', validate(phoneSendCodeSchema), postSendPhoneCode);
router.post('/verify', validate(phoneVerifyCodeSchema), postVerifyPhoneCode);

export const phoneAuthRouter = router;
