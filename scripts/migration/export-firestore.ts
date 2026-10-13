import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { archiveDocument, canonical } from './archive-codec';
import { firestoreSource } from './firestore-source';
import { inventory } from './inventory';
import type { Manifest } from './bundle';

export async function exportFirestore(
  project: string,
  database: string,
  directory: string,
): Promise<Manifest> {
  const { client, root } = firestoreSource(project, database);
  // Every listing uses exactly the same readTime; the source must support the
  // requested read window. Final cutover still freezes writers before this call.
  const milliseconds = Date.now() - 5000;
  const readTime = {
    seconds: String(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1e6,
  };
  await mkdir(resolve(directory), { mode: 0o700 });
  const output = await open(resolve(directory, 'documents.ndjson'), 'wx', 0o600);
  const digest = createHash('sha256');
  let writing = Promise.resolve();
  try {
    const report = await inventory(
      {
        collectionIds: (parent) =>
          client.listCollectionIdsAsync(
            { parent, readTime, pageSize: 100 },
            { timeout: 15000, retry: null },
          ),
        documents: (parent, collectionId) =>
          client.listDocumentsAsync(
            { parent, collectionId, readTime, showMissing: true, pageSize: 100 },
            { timeout: 15000, retry: null },
          ),
      },
      root,
      100000,
      {
        onDocument: (document) => {
          const line = canonical(archiveDocument(document, root)) + '\n';
          writing = writing.then(async () => {
            digest.update(line);
            await output.writeFile(line);
          });
          return writing;
        },
        onProgress: (count) => console.error(`Export scanned ${count} document paths`),
      },
    );
    await writing;
    await output.sync();
    const manifest: Manifest = {
      schemaVersion: 1,
      runId: randomUUID(),
      source: { project, database },
      readTime: new Date(milliseconds).toISOString(),
      documents: report.documents,
      missingAncestors: report.missingAncestors,
      sha256: digest.digest('hex'),
      complete: true,
      origin: 'firestore-snapshot',
      unmappedSchemas: Object.entries(report.collections)
        .filter(([, stats]) => stats.mapping === 'requires-review')
        .map(([schema]) => schema)
        .sort(),
    };
    await writeFile(resolve(directory, 'manifest.json'), canonical(manifest) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return manifest;
  } finally {
    await output.close();
    await client.close();
  }
}
