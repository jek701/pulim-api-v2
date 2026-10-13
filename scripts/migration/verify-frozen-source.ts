import { documentsIn, validateBundle } from './bundle';
import { canonical } from './archive-codec';
import { firestoreSource } from './firestore-source';

/** Fast final check for this root-only source, after every writer is stopped.
 * Rejects nested archives rather than silently claiming to verify them. */
export async function verifyFrozenSource(
  directory: string,
): Promise<{ ok: boolean; compared: number; changed: number }> {
  const manifest = await validateBundle(directory);
  const expected = new Map<string, string>();
  for await (const document of documentsIn(directory)) {
    if (document.path.split('/').length !== 2 || !document.updateTime)
      throw new Error('FROZEN_CHECK_REQUIRES_ROOT_ONLY_ARCHIVE');
    expected.set(document.path, canonical(document.updateTime));
  }
  const { client, root } = firestoreSource(manifest.source.project, manifest.source.database);
  let compared = 0;
  let changed = 0;
  try {
    for await (const collectionId of client.listCollectionIdsAsync(
      { parent: root },
      { timeout: 15000, retry: null, autoPaginate: false },
    )) {
      for await (const document of client.listDocumentsAsync(
        { parent: root, collectionId, showMissing: true, mask: { fieldPaths: [] } },
        { timeout: 15000, retry: null, autoPaginate: false },
      )) {
        const path = document.name?.slice(root.length + 1);
        const update = document.updateTime as
          | { seconds?: string | number | null; nanos?: number | null }
          | undefined;
        if (
          !path ||
          !update ||
          expected.get(path) !==
            canonical({ seconds: String(update.seconds ?? 0), nanos: Number(update.nanos ?? 0) })
        )
          changed++;
        if (path) expected.delete(path);
        compared++;
      }
    }
    changed += expected.size;
    return { ok: changed === 0 && compared === manifest.documents, compared, changed };
  } finally {
    await client.close();
  }
}
