import { Router } from 'express';
import { userScopedRepo } from '../repositories/base.repository';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { renameChatSchema } from '../domain/schemas';

const router = Router();
const repo = userScopedRepo('aiChats');

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await repo.list(req.uid, { field: 'updatedAt', dir: 'desc' }));
  }),
);

router.patch(
  '/:id',
  validate(renameChatSchema),
  asyncHandler(async (req, res) => {
    res.json(await repo.update(req.uid, String(req.params.id), { title: req.body.title }));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await repo.remove(req.uid, String(req.params.id));
    res.status(204).end();
  }),
);

export const aiChatsRouter = router;
