import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // Response already started (e.g. an SSE stream) — let Express tear it down.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: err.flatten() },
    });
    return;
  }

  // Firebase Admin auth errors (verifyIdToken, etc.)
  const code = (err as { code?: string })?.code;
  if (typeof code === 'string' && code.startsWith('auth/')) {
    res.status(401).json({
      error: { code: 'AUTH_INVALID_TOKEN', message: 'Invalid or expired credentials.' },
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
};
