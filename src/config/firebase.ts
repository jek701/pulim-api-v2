import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
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

const app = admin.initializeApp({
  credential: buildCredential(),
  projectId: env.FIREBASE_PROJECT_ID,
});

export const db = env.FIRESTORE_DATABASE_ID
  ? getFirestore(app, env.FIRESTORE_DATABASE_ID)
  : admin.firestore(app);
// Mirror the frontend's "strip undefined before writes" behaviour at the SDK level.
db.settings({ ignoreUndefinedProperties: true });

export const auth = admin.auth(app);
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
export { admin };

export type DecodedToken = admin.auth.DecodedIdToken;
