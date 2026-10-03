import { Router, type RequestHandler } from 'express';
import { devNotesUids } from '../config/env';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { devNoteCreateSchema, devNoteReplySchema } from '../devNotes/domain';
import {
  addOwnerReply,
  createDevNote,
  deleteOwnDevNote,
  getOwnScreenshot,
  listOwnDevNotes,
} from '../devNotes/devNotes.repository';

/** Everyone outside DEV_NOTES_UIDS gets a 404, so the feature stays invisible. */
const requireDevNotesOwner: RequestHandler = (req, _res, next) => {
  next(devNotesUids.has(req.uid) ? undefined : AppError.notFound());
};

const router = Router();

router.get('/access', (req, res) => {
  res.json({ enabled: devNotesUids.has(req.uid) });
});

router.use(requireDevNotesOwner);

router.get('/', asyncHandler(async (req, res) => {
  res.json(await listOwnDevNotes(req.uid));
}));

router.post('/', validate(devNoteCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await createDevNote({ uid: req.uid, source: 'app', ...req.body }));
}));

router.get('/:id/screenshot', asyncHandler(async (req, res) => {
  res.json({ dataUrl: await getOwnScreenshot(req.uid, String(req.params.id)) });
}));

router.post('/:id/replies', validate(devNoteReplySchema), asyncHandler(async (req, res) => {
  res.json(await addOwnerReply(req.uid, String(req.params.id), req.body.text));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await deleteOwnDevNote(req.uid, String(req.params.id));
  res.status(204).end();
}));

export const devNotesRouter = router;
