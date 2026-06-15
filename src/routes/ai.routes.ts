import { Router } from 'express';
import { validate } from '../middleware/validate';
import { forecastSchema, chatSchema } from '../domain/schemas';
import { postForecast, postChat } from '../controllers/ai.controller';

const router = Router();

router.post('/forecast', validate(forecastSchema), postForecast);
router.post('/chat', validate(chatSchema), postChat);

export const aiRouter = router;
