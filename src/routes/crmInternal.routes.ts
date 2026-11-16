import { Router, type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError';
import { env } from '../config/env';
import { internalHmac } from '../middleware/internalHmac';
import { crmUsers, crmFacts, crmMessage, crmStatuses } from '../controllers/crmInternal.controller';
const router = Router();
router.use(internalHmac({ secret: () => env.PULIM_CRM_INTERNAL_SECRET, scheme: 'crm' }));
router.get('/users', crmUsers);
router.post('/users/facts', crmFacts);
router.post('/messages', crmMessage);
router.post('/messages/status', crmStatuses);
// SQL/SDK errors can include bound identifiers. Keep internal failures out of generic logs.
const safeInternalError: ErrorRequestHandler = (error, _req, _res, next) => {
  next(
    error instanceof AppError || error instanceof ZodError
      ? error
      : new AppError(503, 'CRM_UNAVAILABLE', 'CRM integration is temporarily unavailable.'),
  );
};
router.use(safeInternalError);
export const crmInternalRouter = router;
