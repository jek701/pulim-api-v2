import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ArchivedDocument } from './archive-codec';

export interface Manifest {
  schemaVersion: 1;
  runId: string;
  source: { project: string; database: string };
  readTime: string;
  documents: number;
  missingAncestors: number;
  sha256: string;
  complete: true;
  origin: 'firestore-snapshot' | 'mysql-current';
  unmappedSchemas: string[];
}
export async function* documentsIn(directory: string): AsyncGenerator<ArchivedDocument> {
  const input = createReadStream(resolve(directory, 'documents.ndjson'), { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) throw new Error('EMPTY_ARCHIVE_LINE');
      const document = JSON.parse(line) as ArchivedDocument;
      const segments = document.path?.split('/');
      if (
        !segments ||
        segments.length < 2 ||
        segments.length % 2 ||
        segments.some((part) => !part) ||
        !document.fields ||
        typeof document.fields !== 'object' ||
        Array.isArray(document.fields)
      )
        throw new Error('INVALID_ARCHIVE_DOCUMENT');
      yield document;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}
export async function validateBundle(directory: string): Promise<Manifest> {
  const manifest = JSON.parse(
    await readFile(resolve(directory, 'manifest.json'), 'utf8'),
  ) as Manifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.complete !== true ||
    !manifest.runId ||
    !manifest.source?.project ||
    !manifest.source?.database ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.documents) ||
    manifest.documents < 0
  )
    throw new Error('INVALID_MANIFEST');
  if (!(await stat(resolve(directory, 'documents.ndjson'))).isFile())
    throw new Error('INVALID_ARCHIVE_FILE');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(resolve(directory, 'documents.ndjson')))
    digest.update(chunk);
  if (digest.digest('hex') !== manifest.sha256) throw new Error('ARCHIVE_CHECKSUM_MISMATCH');
  const seen = new Set<string>();
  for await (const document of documentsIn(directory)) {
    if (seen.has(document.path)) throw new Error('DUPLICATE_ARCHIVE_PATH');
    seen.add(document.path);
  }
  if (seen.size !== manifest.documents) throw new Error('ARCHIVE_COUNT_MISMATCH');
  return manifest;
}
