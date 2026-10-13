import { readFile, writeFile } from 'node:fs/promises';
import { canonical, hash, rawFields, type ArchivedDocument } from './archive-codec';
import { documentsIn, validateBundle } from './bundle';
import { firestoreSource } from './firestore-source';

export interface RestorePlan {
  sourceRunId: string;
  currentRunId: string;
  sourceSha256: string;
  currentSha256: string;
  actions: Array<{ operation: 'create' | 'update' | 'delete'; path: string; fieldsHash?: string }>;
}
/** Diff only the source-manifest scope and SQL-created documents; never enumerate/delete unrelated cloud data. */
export async function restorePlan(
  sourceDirectory: string,
  currentDirectory: string,
): Promise<RestorePlan> {
  const sourceManifest = await validateBundle(sourceDirectory);
  const currentManifest = await validateBundle(currentDirectory);
  if (
    sourceManifest.source.project !== currentManifest.source.project ||
    sourceManifest.source.database !== currentManifest.source.database
  )
    throw new Error('RESTORE_SOURCE_MISMATCH');
  const source = new Map<string, ArchivedDocument>();
  const current = new Map<string, ArchivedDocument>();
  for await (const document of documentsIn(sourceDirectory)) source.set(document.path, document);
  for await (const document of documentsIn(currentDirectory)) current.set(document.path, document);
  const actions: RestorePlan['actions'] = [];
  for (const [path, document] of current) {
    const prior = source.get(path);
    if (!prior || hash(prior.fields) !== hash(document.fields))
      actions.push({
        operation: prior ? 'update' : 'create',
        path,
        fieldsHash: hash(document.fields),
      });
  }
  for (const path of source.keys())
    if (!current.has(path)) actions.push({ operation: 'delete', path });
  actions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    sourceRunId: sourceManifest.runId,
    currentRunId: currentManifest.runId,
    sourceSha256: sourceManifest.sha256,
    currentSha256: currentManifest.sha256,
    actions,
  };
}
export async function writeRestorePlan(
  source: string,
  current: string,
  output: string,
): Promise<RestorePlan> {
  const plan = await restorePlan(source, current);
  await writeFile(output, canonical(plan) + '\n', { flag: 'wx', mode: 0o600 });
  return plan;
}

export async function applyRestore(options: {
  source: string;
  current: string;
  reviewedPlan: string;
  project: string;
  database: string;
  writersStopped: boolean;
  applyDeletes: boolean;
  recoveryDatabase: boolean;
}): Promise<number> {
  if (!options.writersStopped) throw new Error('WRITERS_MUST_BE_STOPPED');
  const expected = await restorePlan(options.source, options.current);
  const reviewed = JSON.parse(await readFile(options.reviewedPlan, 'utf8')) as RestorePlan;
  if (hash(expected) !== hash(reviewed)) throw new Error('RESTORE_PLAN_CHANGED');
  if (
    expected.actions.some((action) => action.operation === 'delete') &&
    !options.applyDeletes &&
    !options.recoveryDatabase
  )
    throw new Error('EXPLICIT_DELETE_MODE_REQUIRED');
  const sourceManifest = await validateBundle(options.source);
  if (options.project !== sourceManifest.source.project) throw new Error('TARGET_PROJECT_MISMATCH');
  if (options.recoveryDatabase && options.database === sourceManifest.source.database)
    throw new Error('RECOVERY_MUST_USE_SEPARATE_DATABASE');
  if (!options.recoveryDatabase && options.database !== sourceManifest.source.database)
    throw new Error('DIFF_RESTORE_REQUIRES_ORIGINAL_DATABASE');
  const current = new Map<string, ArchivedDocument>();
  for await (const document of documentsIn(options.current)) current.set(document.path, document);
  const { client, root } = firestoreSource(options.project, options.database);
  try {
    // A separate recovery DB needs full state, not just changed rows. Ensure it is
    // empty before writing. Indexes/rules/TTL must be restored separately by operator.
    if (options.recoveryDatabase) {
      for await (const _collection of client.listCollectionIdsAsync({ parent: root, pageSize: 1 }))
        throw new Error('RECOVERY_DATABASE_NOT_EMPTY');
    }
    const actions = options.recoveryDatabase
      ? [...current.values()].map((document) => ({
          operation: 'create' as const,
          path: document.path,
        }))
      : expected.actions;
    for (let offset = 0; offset < actions.length; offset += 400) {
      const writes = actions.slice(offset, offset + 400).map((action) => {
        const name = `${root}/${action.path}`;
        if (action.operation === 'delete') return { delete: name };
        return { update: { name, fields: rawFields(current.get(action.path)!.fields) } };
      });
      await client.commit({
        database: `projects/${options.project}/databases/${options.database}`,
        writes: writes as any,
      });
    }
    return actions.length;
  } finally {
    await client.close();
  }
}
