import { Router } from 'express';
import { validate } from '../middleware/validate';
import { telegramAuthSchema } from '../domain/schemas';
import { postTelegramAuth } from '../controllers/telegramAuth.controller';

const router = Router();

// POST /auth/telegram — public, self-verifying (Telegram initData + optional ID token).
router.post('/', validate(telegramAuthSchema), postTelegramAuth);

export const telegramAuthRouter = router;
