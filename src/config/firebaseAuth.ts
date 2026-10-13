import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import admin from 'firebase-admin';
import { env } from './env';

function buildCredential(): admin.credential.Credential {
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccount = JSON.parse(
      readFileSync(resolve(env.FIREBASE_SERVICE_ACCOUNT_PATH), 'utf8'),
    );
    return admin.credential.cert(serviceAccount);
  }
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return admin.credential.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  }
  // Fall back to Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS).
  return admin.credential.applicationDefault();
}

export const firebaseApp = admin.initializeApp({
  credential: buildCredential(),
  projectId: env.FIREBASE_PROJECT_ID,
});

export const auth = admin.auth(firebaseApp);
export { admin };
export type DecodedToken = admin.auth.DecodedIdToken;
