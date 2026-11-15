import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { accountDeletionLimiter } from '../middleware/rateLimit';
import { postDeleteAccount } from '../controllers/account.controller';

export const accountRouter = Router();
accountRouter.post(
  '/delete',
  validate(z.object({ confirm: z.literal('DELETE') }).strict()),
  accountDeletionLimiter,
  postDeleteAccount,
);
