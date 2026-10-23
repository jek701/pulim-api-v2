import { Router } from 'express';
import { validate } from '../middleware/validate';
import { telegramLoginExchangeLimiter, telegramLoginRequestLimiter } from '../middleware/rateLimit';
import {
  telegramLoginExchangeSchema,
  telegramLoginParamsSchema,
  telegramLoginRequestSchema,
} from '../domain/schemas';
import {
  getTelegramAppReturn,
  postTelegramLoginExchange,
  postTelegramLoginRequest,
} from '../controllers/telegramLogin.controller';

const router = Router();

// Public — native-app login through the bot deep link. Mounted at /auth/telegram,
// ahead of the Mini App route, with its own limits (the app polls the exchange).
router.post('/login-request', telegramLoginRequestLimiter, validate(telegramLoginRequestSchema), postTelegramLoginRequest);
router.post(
  '/login-request/:requestId/exchange',
  telegramLoginExchangeLimiter,
  validate(telegramLoginParamsSchema, 'params'),
  validate(telegramLoginExchangeSchema),
  postTelegramLoginExchange,
);
router.get('/app-return', getTelegramAppReturn);

export const telegramLoginRouter = router;
