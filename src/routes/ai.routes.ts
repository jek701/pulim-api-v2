import { planSetupSchema } from '../plans/schemas';
import { requirePremium } from '../middleware/requirePremium';
import { Router } from 'express';
import { validate } from '../middleware/validate';
import { forecastSchema, chatSchema, aiFeedbackSchema } from '../domain/schemas';
import { postForecast, postChat, postFeedback, postPlanSetup } from '../controllers/ai.controller';

const router = Router();

router.post(
  '/plan-setup',
  requirePremium('planned_expenses'),
  validate(planSetupSchema),
  postPlanSetup,
);
router.post('/forecast', validate(forecastSchema), postForecast);
router.post('/chat', validate(chatSchema), postChat);
router.post('/feedback', validate(aiFeedbackSchema), postFeedback);

export const aiRouter = router;
