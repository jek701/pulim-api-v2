import { Router, type Request, type Response } from 'express';
import {
  addShortcutExpense,
  authenticateShortcut,
  languageFromHeader,
  listShortcutCards,
  listShortcutCategories,
  ShortcutError,
  type ShortcutUser,
} from '../services/shortcut.service';
import { logger } from '../utils/logger';

/**
 * Public endpoints for the iPhone Shortcut, authenticated by a personal key.
 * Shortcuts show response bodies to the user as is, so every response —
 * including errors — is a ready-to-read message: list endpoints return a JSON
 * array of labels (an error becomes a one-item list), `POST /expenses` returns text.
 */
const router = Router();

const FAILED = {
  ru: '⚠️ Что-то пошло не так. Попробуйте ещё раз.',
  uz: '⚠️ Xatolik yuz berdi. Qayta urinib ko‘ring.',
  en: '⚠️ Something went wrong. Please try again.',
} as const;

function handler(
  respond: (user: ShortcutUser, req: Request) => Promise<string[] | string>,
  asList: boolean,
) {
  return async (req: Request, res: Response) => {
    const fallback = languageFromHeader(req.header('accept-language'));
    let status = 200;
    let body: string[] | string;
    try {
      const user = await authenticateShortcut(req.header('authorization'), fallback);
      body = await respond(user, req);
    } catch (error) {
      if (error instanceof ShortcutError) {
        status = error.status;
        body = error.text;
      } else {
        logger.error({ err: error }, 'shortcut.request_failed');
        status = 500;
        body = FAILED[fallback];
      }
      if (asList) body = [body];
    }
    if (Array.isArray(body)) res.status(status).json(body);
    else res.status(status).type('text/plain; charset=utf-8').send(body);
  };
}

router.get('/cards', handler((user) => listShortcutCards(user), true));
router.get('/categories', handler((user) => listShortcutCategories(user), true));
router.post('/expenses', handler((user, req) => addShortcutExpense(user, (req.body ?? {}) as Record<string, unknown>), false));

export const shortcutRouter = router;
