import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export function captureFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // OpenAI/HTTP exceptions can contain request bodies; log only the class and HTTP status.
  const status = (error as { status?: unknown } | null)?.status;
  logger.warn({ errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof status === 'number' ? { status } : {}) }, 'capture.recognition_failed');
  return new AppError(502, 'capture_provider_failed', 'Recognition is temporarily unavailable.');
}
