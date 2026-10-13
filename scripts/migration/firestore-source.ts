import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v1 } from '@google-cloud/firestore';

export function firestoreSource(project: string, database: string) {
  if (!project || !database || (project + database).includes('/'))
    throw new Error('EXPLICIT_SOURCE_REQUIRED');
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const account = path ? JSON.parse(readFileSync(resolve(path), 'utf8')) : undefined;
  const email = account?.client_email ?? process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = account?.private_key ?? process.env.FIREBASE_PRIVATE_KEY;
  if (Boolean(email) !== Boolean(privateKey)) throw new Error('INCOMPLETE_CREDENTIALS');
  const client = new v1.FirestoreClient({
    projectId: project,
    fallback: true,
    ...(email && privateKey
      ? { credentials: { client_email: email, private_key: privateKey.replace(/\\n/g, '\n') } }
      : {}),
  });
  return { client, root: `projects/${project}/databases/${database}/documents` };
}
