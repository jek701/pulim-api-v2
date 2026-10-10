import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { getShortcutTokenStatus, issueShortcutToken, revokeShortcutTokens } from '../services/shortcut.service';

/** Signed-in management of the personal iPhone Shortcut key (Settings → iPhone quick entry). */
const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await getShortcutTokenStatus(req.uid));
}));

// The plain key is returned exactly once, here.
router.post('/', asyncHandler(async (req, res) => {
  res.status(201).json(await issueShortcutToken(req.uid));
}));

router.delete('/', asyncHandler(async (req, res) => {
  await revokeShortcutTokens(req.uid);
  res.status(204).end();
}));

export const shortcutTokenRouter = router;
