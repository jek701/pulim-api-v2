import { asyncHandler } from '../utils/asyncHandler';
import { auth } from '../config/firebaseAuth';
import { AppError } from '../utils/AppError';
import { readDocument, documentKey } from '../db/documents';

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

  const deleting = req.method === 'POST' && /^\/account\/delete\/?$/.test(req.path);
  const bootstrap = req.method === 'POST' && /^\/profile\/bootstrap\/?$/.test(req.path);
  // Only bootstrap needs the network revocation check to prevent profile resurrection.
  const decoded = await auth.verifyIdToken(idToken, bootstrap).catch((error: { code?: string }) => {
    if (
      bootstrap &&
      ![
        'auth/id-token-expired',
        'auth/id-token-revoked',
        'auth/user-disabled',
        'auth/user-not-found',
        'auth/argument-error',
        'auth/invalid-id-token',
      ].includes(error.code ?? '')
    )
      throw new AppError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    throw error;
  });
  if (deleting) {
    try {
      const user = await auth.getUser(decoded.uid);
      // Telegram may reuse its deterministic uid on a genuinely new sign-in. An old token
      // can resume the old deletion, but must never delete that new Firebase account.
      if (decoded.auth_time < Math.floor(Date.parse(user.metadata.creationTime) / 1000))
        throw AppError.unauthorized('Sign in again to delete this account.');
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
    }
  }
  if (!deleting) {
    const profile = await readDocument(documentKey('profiles', decoded.uid));
    if (profile.data?.deletionRequestedAt)
      throw AppError.conflict('ACCOUNT_DELETION_IN_PROGRESS', 'Account deletion is in progress.');
  }
  req.uid = decoded.uid;
  req.claims = decoded;
  next();
});
