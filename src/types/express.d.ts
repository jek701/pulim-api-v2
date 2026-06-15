import type { DecodedIdToken } from 'firebase-admin/auth';

declare global {
  namespace Express {
    interface Request {
      /** Firebase uid, set by the `authenticate` middleware. */
      uid: string;
      /** Decoded Firebase ID token claims, set by the `authenticate` middleware. */
      claims: DecodedIdToken;
    }
  }
}

export {};
