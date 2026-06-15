import type { RequestHandler } from 'express';
import type { ZodSchema } from 'zod';
import { AppError } from '../utils/AppError';

type Target = 'body' | 'params' | 'query';

/**
 * Validates `req[target]` against a zod schema. On success replaces the value
 * with the parsed result (except `query`, which is read-only in Express 5).
 */
export const validate =
  (schema: ZodSchema, target: Target = 'body'): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      next(new AppError(400, 'VALIDATION_ERROR', 'Invalid request.', result.error.flatten()));
      return;
    }
    if (target !== 'query') {
      (req as unknown as Record<string, unknown>)[target] = result.data;
    }
    next();
  };
