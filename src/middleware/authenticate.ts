import { asyncHandler } from '../utils/asyncHandler';
import { auth } from '../config/firebase';
import { AppError } from '../utils/AppError';

/**
 * Verifies the Firebase ID token from `Authorization: Bearer <token>` and
 * attaches `req.uid` + `req.claims`. Applied to every `/v1/*` route.
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or malformed Authorization header.');
  }
  const idToken = header.slice('Bearer '.length).trim();
  if (!idToken) throw AppError.unauthorized('Empty bearer token.');

  const decoded = await auth.verifyIdToken(idToken);
  req.uid = decoded.uid;
  req.claims = decoded;
  next();
});
