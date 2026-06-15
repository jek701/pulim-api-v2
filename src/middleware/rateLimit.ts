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
