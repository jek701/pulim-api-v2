import { Router } from 'express';
import { validate } from '../middleware/validate';
import { forecastSchema, chatSchema, aiFeedbackSchema } from '../domain/schemas';
import { postForecast, postChat, postFeedback } from '../controllers/ai.controller';

const router = Router();

router.post('/forecast', validate(forecastSchema), postForecast);
router.post('/chat', validate(chatSchema), postChat);
router.post('/feedback', validate(aiFeedbackSchema), postFeedback);

export const aiRouter = router;
