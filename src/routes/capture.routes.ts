import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { captureCapabilities } from '../capture/availability';
import { captureQuota } from '../capture/quota';
import { captureVoice, capturePhoto, captureSoliq } from '../capture/service';
import { captureFailure } from '../capture/errors';
import { SOLIQ_ENDPOINT } from '../capture/soliq';
import { env } from '../config/env';
import { readCaptureUpload, validateCaptureMedia } from '../capture/upload';
import { captureTimezone } from '../capture/time';

const router = Router();

const unavailable = () => new AppError(503, 'capture_disabled', 'Voice and receipt capture are not available.');
/** Capability gate per feature, so a dark feature cannot be reached by guessing the URL. */
const requires = (feature: 'voice' | 'receipt' | 'any'): RequestHandler => asyncHandler(async (_req, _res, next) => {
  const capabilities = await captureCapabilities();
  if (feature === 'any' ? !(capabilities.voice || capabilities.receipt) : !capabilities[feature]) throw unavailable();
  next();
});
const limiter = (max: number) => rateLimit({
  windowMs: 60_000, max, keyGenerator: req => req.uid, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ code: 'capture_rate_limited', error: { code: 'capture_rate_limited' } }); },
});
/** Input problems are the caller's; a ZodError raised later by model output is not. */
const input = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid capture request.');
  return parsed.data;
};

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // Guests (anonymous Firebase users) have no account to bill or learn against.
  if (req.claims?.firebase?.sign_in_provider === 'anonymous') next(AppError.unauthorized('Sign in to use capture.'));
  else next();
});

const voiceFields = z.object({ timezone: captureTimezone.optional(), language: z.enum(['uz', 'ru', 'en']).optional() }).strict();
const photoFields = voiceFields.omit({ language: true });
const soliqBody = z.object({ url: z.string().max(2048), timezone: captureTimezone.optional(),
  raw: z.record(z.string(), z.unknown()).optional() }).strict();

/**
 * Aborts when the client goes away before the response was written, so the quota slot it paid
 * for is given back (it never saw the answer).
 */
const disconnected = (res: import('express').Response): AbortSignal => {
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
};

router.get('/quota', requires('any'), limiter(60), asyncHandler(async (req, res) => {
  res.json(await captureQuota(req.uid));
}));
/**
 * The prod API server is geo-blocked from *.soliq.uz, so the phone fetches the receipt itself and
 * uploads it. It signs the request with this key: Soliq's own public web-bundle constant, never logged.
 */
router.get('/soliq-config', requires('receipt'), limiter(30), (_req, res) => {
  if (!env.SOLIQ_OFD_SIGNING_KEY.trim()) throw unavailable();
  res.json({ signingKey: env.SOLIQ_OFD_SIGNING_KEY, endpoint: SOLIQ_ENDPOINT });
});
router.post('/voice', requires('voice'), limiter(20), asyncHandler(async (req, res) => {
  const upload = await readCaptureUpload(req, 'audio');
  const fields = input(voiceFields, upload.fields);
  validateCaptureMedia(upload.buffer, upload.mime, 'audio');
  res.json(await captureVoice(req.uid, upload.buffer, upload.mime, fields.timezone, fields.language, disconnected(res)));
}));
router.post('/receipt/photo', requires('receipt'), limiter(20), asyncHandler(async (req, res) => {
  const upload = await readCaptureUpload(req, 'image');
  const fields = input(photoFields, upload.fields);
  validateCaptureMedia(upload.buffer, upload.mime, 'image');
  res.json(await capturePhoto(req.uid, upload.buffer, fields.timezone, disconnected(res)));
}));
// Soft per-user limit on the unofficial Soliq endpoint, tighter than the recognition calls.
router.post('/receipt/soliq', requires('receipt'), limiter(10), asyncHandler(async (req, res) => {
  const body = input(soliqBody, req.body);
  res.json(await captureSoliq(req.uid, body.url, body.timezone, disconnected(res), body.raw));
}));

/**
 * Contract bodies are flat (`{ code, quota }`, `{ code: 'soliq_unavailable' }`). The usual
 * `{ error: { code, message } }` envelope is included too so generic clients keep working.
 * Provider/OpenAI exceptions never reach the response or the log.
 */
const captureErrors: ErrorRequestHandler = (error, _req, res, _next) => {
  const safe = captureFailure(error);
  const quota = safe.code === 'capture_quota_exceeded' ? (safe.details as { quota?: unknown } | undefined)?.quota : undefined;
  res.status(safe.statusCode).json({
    code: safe.code, message: safe.message, error: { code: safe.code, message: safe.message },
    ...(quota ? { quota } : {}),
  });
};
router.use(captureErrors);
export const captureRouter = router;
