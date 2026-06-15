/**
 * Typed application error. The central error handler turns this into a
 * consistent JSON envelope: { error: { code, message, details? } }.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required.') {
    return new AppError(401, 'AUTH_REQUIRED', message);
  }
  static forbidden(code: string, message: string) {
    return new AppError(403, code, message);
  }
  static notFound(message = 'Resource not found.') {
    return new AppError(404, 'NOT_FOUND', message);
  }
}
