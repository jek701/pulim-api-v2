import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env';

const json429 = (message: string) => (_req: Request, res: Response) => {
  res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
};

/** Per-user limit on AI inference (applied after `authenticate`, so req.uid is set). */
export const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.AI_RATE_LIMIT_PER_MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.uid,
  handler: json429('Too many AI requests. Please slow down.'),
});

/** Per-IP limit on the public Telegram auth endpoint. */
export const telegramAuthLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json429('Too many auth attempts. Please try again shortly.'),
});

/**
 * Per-IP guard on phone sign-in. With reCAPTCHA gone this is the only limit that
 * does not depend on the submitted number; per-number cooldowns and attempt caps
 * are enforced in `phoneAuth.service`.
 */
export const phoneAuthLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json429('Too many verification requests. Please try again shortly.'),
});

/** Broad IP guard; Telegram-specific per-user limits are enforced after identity resolution. */
export const telegramWebhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: json429('Too many webhook requests.'),
});
