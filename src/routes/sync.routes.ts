import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import {
  SYNC_DEFAULT_LIMIT,
  SYNC_MAX_LIMIT,
  pullChanges,
  syncCapabilities,
} from '../services/sync.service';

const changesQuerySchema = z.object({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(SYNC_MAX_LIMIT).default(SYNC_DEFAULT_LIMIT),
});

const router = Router();

router.get('/capabilities', (_req, res) => {
  res.json(syncCapabilities());
});
router.get(
  '/changes',
  asyncHandler(async (req, res) => {
    const parsed = changesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request.', parsed.error.flatten());
    }
    res.set('Cache-Control', 'no-store');
    res.json(await pullChanges(req.uid, parsed.data.cursor, parsed.data.limit));
  }),
);

export const syncRouter = router;
