import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { v1 } from '@google-cloud/firestore';
import { inventory, type InventorySource } from './inventory';

// Deliberately does not import dotenv/config, app/server, or config/firebase.
// Source selection is explicit; credentials may be supplied using Node --env-file.
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      database: { type: 'string' },
      out: { type: 'string' },
      'max-documents': { type: 'string', default: '100000' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Read-only live inventory (not a migration snapshot).\nUsage: data:inventory -- --project PROJECT --database DATABASE --out /private/path/report.json [--max-documents 100000]',
    );
    return;
  }
  const projectId = values.project;
  const databaseId = values.database;
  const maxDocuments = Number(values['max-documents']);
  if (
    !projectId ||
    !databaseId ||
    !values.out ||
    /\//.test(projectId + databaseId) ||
    !Number.isSafeInteger(maxDocuments) ||
    maxDocuments < 1
  ) {
    throw new Error('EXPLICIT_SOURCE_AND_OUTPUT_REQUIRED');
  }
  if (
    (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== projectId) ||
    (process.env.FIRESTORE_DATABASE_ID && process.env.FIRESTORE_DATABASE_ID !== databaseId)
  ) {
    throw new Error('SOURCE_ENV_MISMATCH');
  }

  // Refuse to overwrite an earlier report; create with owner-only permissions.
  const output = await open(resolve(values.out), 'wx', 0o600);
  let client: InstanceType<typeof v1.FirestoreClient> | undefined;
  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const serviceAccount = serviceAccountPath
      ? (JSON.parse(readFileSync(resolve(serviceAccountPath), 'utf8')) as Record<string, string>)
      : undefined;
    const clientEmail = serviceAccount?.client_email ?? process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = serviceAccount?.private_key ?? process.env.FIREBASE_PRIVATE_KEY;
    if (Boolean(clientEmail) !== Boolean(privateKey)) throw new Error('INCOMPLETE_CREDENTIALS');
    client = new v1.FirestoreClient({
      projectId,
      fallback: true,
      ...(clientEmail && privateKey
        ? {
            credentials: {
              client_email: clientEmail,
              private_key: privateKey.replace(/\\n/g, '\n'),
            },
          }
        : {}),
    });
    const source: InventorySource = {
      collectionIds: (parent) =>
        client!.listCollectionIdsAsync({ parent, pageSize: 100 }, { timeout: 15000, retry: null }),
      documents: (parent, collectionId) =>
        client!.listDocumentsAsync(
          {
            parent,
            collectionId,
            showMissing: true,
            pageSize: 100,
          },
          { timeout: 15000, retry: null },
        ),
    };
    const startedAt = new Date().toISOString();
    const result = await inventory(
      source,
      `projects/${projectId}/databases/${databaseId}/documents`,
      maxDocuments,
      { onProgress: (count) => console.error(`Scanned ${count} document paths`) },
    );
    await output.writeFile(
      JSON.stringify(
        {
          schemaVersion: 1,
          projectId,
          databaseId,
          startedAt,
          finishedAt: new Date().toISOString(),
          consistency: 'live-not-a-snapshot',
          completeTraversal: true,
          scope:
            'collection schemas and value types; does not verify references, TTL, IAM, or backup restoration',
          ...result,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `Inventory complete: ${result.documents} documents, ${result.missingAncestors} missing ancestors. Report saved locally.`,
    );
  } finally {
    await output.close();
    await client?.close();
  }
}

void main().catch((error: unknown) => {
  // SDK errors may contain document paths or credentials; do not echo them.
  const safeReasons: Record<string, string> = {
    EXPLICIT_SOURCE_AND_OUTPUT_REQUIRED:
      'Pass --project, --database, --out and a positive --max-documents.',
    SOURCE_ENV_MISMATCH: 'Explicit source does not match the source environment variables.',
    INCOMPLETE_CREDENTIALS: 'Client email and private key must be provided together.',
    INVENTORY_LIMIT_REACHED: 'Document scan limit reached; rerun with a larger explicit limit.',
    INVALID_DOCUMENT_PATH: 'Source returned a document outside the requested collection.',
  };
  const reason = error instanceof Error ? safeReasons[error.message] : undefined;
  console.error(
    `Inventory failed; no complete report produced. ${reason ?? 'Check credentials, connectivity and output path.'} Use --help for usage.`,
  );
  process.exitCode = 1;
});
