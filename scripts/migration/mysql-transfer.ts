import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { database } from '../../src/db/database';
import { documentKey, projected, syncHouseholdMembers } from '../../src/db/documents';
import { tables, type Entity } from '../../src/db/tables';
import { decodeData, encodeData } from '../../src/db/values';
import {
  canonical,
  hash,
  runtimeDocument,
  typedFields,
  type ArchivedDocument,
  type TypedValue,
} from './archive-codec';
import { documentsIn, validateBundle, type Manifest } from './bundle';

function mapped(path: string): { table: Entity; id: string } | null {
  const parts = path.split('/');
  return parts.length === 2 && Object.hasOwn(tables, parts[0])
    ? { table: parts[0] as Entity, id: parts[1] }
    : null;
}
function assertRuntimeValues(value: TypedValue): void {
  if (
    value.type === 'integer' &&
    (BigInt(value.value) > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(value.value) < BigInt(Number.MIN_SAFE_INTEGER))
  )
    throw new Error('UNSAFE_RUNTIME_NUMBER');
  if (value.type === 'double' && !Number.isFinite(Number(value.value)))
    throw new Error('UNSAFE_RUNTIME_NUMBER');
  if (value.type === 'map')
    for (const child of Object.values(value.fields)) assertRuntimeValues(child);
  if (value.type === 'array') for (const child of value.values) assertRuntimeValues(child);
}
const archiveFrom = (value: any): ArchivedDocument =>
  typeof value === 'string' ? JSON.parse(value) : value;
export async function importMysql(
  directory: string,
  archiveUnknown = false,
): Promise<{ imported: number; archived: number }> {
  const manifest = await validateBundle(directory);
  // Full preflight runs before any write. Special numbers in runtime documents
  // must receive explicit domain mappings; an archive alone is not a working DTO.
  for await (const document of documentsIn(directory)) {
    const mapping = mapped(document.path);
    if (!mapping && !archiveUnknown) throw new Error('UNMAPPED_COLLECTIONS_REQUIRE_REVIEW');
    if (mapping) {
      documentKey(mapping.table, mapping.id);
      for (const value of Object.values(document.fields)) assertRuntimeValues(value);
      projected(runtimeDocument(document));
    }
  }
  const db = database();
  const existing = await db
    .selectFrom('migration_runs')
    .selectAll()
    .where('id', '=', manifest.runId)
    .executeTakeFirst();
  if (existing) {
    const previous =
      typeof existing.manifest_json === 'string'
        ? JSON.parse(existing.manifest_json)
        : existing.manifest_json;
    if (hash(previous) !== hash(manifest)) throw new Error('RUN_MANIFEST_CONFLICT');
  } else {
    for (const table of [
      ...Object.values(tables),
      'legacy_documents',
      'migration_documents',
      'migration_runs',
      'household_members',
    ]) {
      if (await db.selectFrom(table).selectAll().limit(1).executeTakeFirst())
        throw new Error('IMPORT_REQUIRES_EMPTY_TARGET');
    }
    await db
      .insertInto('migration_runs')
      .values({
        id: manifest.runId,
        manifest_json: canonical(manifest),
        status: 'importing',
        updated_at: new Date(),
      })
      .execute();
  }
  let imported = 0;
  let archived = 0;
  for await (const document of documentsIn(directory)) {
    const mapping = mapped(document.path);
    await db.transaction().execute(async (tx) => {
      const pathHash = hash(document.path);
      const prior = await tx
        .selectFrom('migration_documents')
        .selectAll()
        .where('path_hash', '=', pathHash)
        .forUpdate()
        .executeTakeFirst();
      if (prior) {
        if (
          prior.path !== document.path ||
          prior.run_id !== manifest.runId ||
          hash(archiveFrom(prior.archive_json)) !== hash(document)
        )
          throw new Error('RESUME_ARCHIVE_CONFLICT');
        if (mapping) {
          const stored = await tx
            .selectFrom(tables[mapping.table])
            .selectAll()
            .where('id', '=', Buffer.from(mapping.id))
            .executeTakeFirst();
          if (
            !stored ||
            hash(typedFields(decodeData(stored.data_json, stored.types_json), document.fields)) !==
              hash(document.fields)
          )
            throw new Error('RESUME_TARGET_CONFLICT');
        }
        return;
      }
      const archive = {
        path_hash: pathHash,
        path: document.path,
        run_id: manifest.runId,
        archive_json: canonical(document),
      };
      if (mapping) {
        const data = runtimeDocument(document);
        await tx
          .insertInto(tables[mapping.table])
          .values({ id: Buffer.from(mapping.id), ...encodeData(data), ...projected(data) })
          .execute();
        await syncHouseholdMembers(tx, mapping, data);
      } else await tx.insertInto('legacy_documents').values(archive).execute();
      await tx.insertInto('migration_documents').values(archive).execute();
    });
    if (mapping) imported++;
    else archived++;
  }
  await db
    .updateTable('migration_runs')
    .set({ status: 'imported', updated_at: new Date() })
    .where('id', '=', manifest.runId)
    .execute();
  return { imported, archived };
}

export async function verifyMysql(directory: string) {
  const manifest = await validateBundle(directory);
  let compared = 0;
  let mismatches = 0;
  let projectionMismatches = 0;
  const expectedCounts = new Map<string, number>();
  for await (const document of documentsIn(directory)) {
    const mapping = mapped(document.path);
    expectedCounts.set(
      mapping ? tables[mapping.table] : 'legacy_documents',
      (expectedCounts.get(mapping ? tables[mapping.table] : 'legacy_documents') ?? 0) + 1,
    );
    if (mapping) {
      const row = await database()
        .selectFrom(tables[mapping.table])
        .selectAll()
        .where('id', '=', Buffer.from(mapping.id))
        .executeTakeFirst();
      if (!row) {
        mismatches++;
        continue;
      }
      const data = decodeData(row.data_json, row.types_json);
      if (hash(typedFields(data, document.fields)) !== hash(document.fields)) mismatches++;
      for (const [column, expected] of Object.entries(projected(data))) {
        const actual = Buffer.isBuffer(row[column]) ? row[column].toString('utf8') : row[column];
        if (
          expected === null
            ? actual !== null
            : typeof expected === 'number'
              ? Number(actual) !== expected
              : actual !== expected
        )
          projectionMismatches++;
      }
      if (mapping.table === 'households') {
        const members = await database()
          .selectFrom('household_members')
          .selectAll()
          .where('household_id', '=', Buffer.from(mapping.id))
          .orderBy('member_index')
          .execute();
        const expected = (Array.isArray(data.memberIds) ? data.memberIds : []).filter(
          (uid: unknown) => typeof uid === 'string',
        );
        if (hash(members.map((row) => row.user_id.toString('utf8'))) !== hash(expected))
          projectionMismatches++;
      }
    } else {
      const row = await database()
        .selectFrom('legacy_documents')
        .selectAll()
        .where('path_hash', '=', hash(document.path))
        .executeTakeFirst();
      if (
        !row ||
        row.path !== document.path ||
        hash(archiveFrom(row.archive_json).fields) !== hash(document.fields)
      )
        mismatches++;
    }
    compared++;
  }
  let countMismatches = 0;
  for (const table of [...Object.values(tables), 'legacy_documents']) {
    const rows = await database()
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as('total'))
      .executeTakeFirstOrThrow();
    if (Number(rows.total) !== (expectedCounts.get(table) ?? 0)) countMismatches++;
  }
  const ok =
    !mismatches && !projectionMismatches && !countMismatches && compared === manifest.documents;
  if (ok)
    await database()
      .updateTable('migration_runs')
      .set({ status: 'verified', updated_at: new Date() })
      .where('id', '=', manifest.runId)
      .execute();
  return {
    ok,
    compared,
    mismatches,
    projectionMismatches,
    countMismatches,
    unmappedSchemas: manifest.unmappedSchemas,
  };
}

/** Current state, including deletes by absence; immutable source archive supplies type hints. */
export async function exportMysql(directory: string): Promise<Manifest> {
  const runs = await database().selectFrom('migration_runs').selectAll().execute();
  if (runs.length !== 1) throw new Error('EXACTLY_ONE_SOURCE_RUN_REQUIRED');
  const baseline = (
    typeof runs[0].manifest_json === 'string'
      ? JSON.parse(runs[0].manifest_json)
      : runs[0].manifest_json
  ) as Manifest;
  await mkdir(resolve(directory), { mode: 0o700 });
  const output = await open(resolve(directory, 'documents.ndjson'), 'wx', 0o600);
  const digest = createHash('sha256');
  let documents = 0;
  try {
    // One consistent SQL snapshot across all tables. Run only with writers closed
    // for operational rollback, but the snapshot itself never mixes commit times.
    await database()
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        const baselineRows = await tx.selectFrom('migration_documents').selectAll().execute();
        const hints = new Map(baselineRows.map((row) => [row.path, archiveFrom(row.archive_json)]));
        async function write(document: ArchivedDocument) {
          const line = canonical(document) + '\n';
          digest.update(line);
          await output.writeFile(line);
          documents++;
        }
        for (const [collection, table] of Object.entries(tables)) {
          // Stream rather than retain screenshots/chat bodies for the whole database.
          for await (const row of tx.selectFrom(table).selectAll().orderBy('id').stream(100)) {
            const id = Buffer.isBuffer(row.id) ? row.id.toString('utf8') : row.id;
            const path = `${collection}/${id}`;
            const prior = hints.get(path);
            await write({
              ...(prior ?? {}),
              path,
              fields: typedFields(decodeData(row.data_json, row.types_json), prior?.fields),
            });
          }
        }
        for await (const row of tx
          .selectFrom('legacy_documents')
          .selectAll()
          .orderBy('path_hash')
          .stream(100))
          await write(archiveFrom(row.archive_json));
      });
    await output.sync();
    const manifest: Manifest = {
      ...baseline,
      runId: randomUUID(),
      documents,
      readTime: new Date().toISOString(),
      origin: 'mysql-current',
      sha256: digest.digest('hex'),
      complete: true,
    };
    await writeFile(resolve(directory, 'manifest.json'), canonical(manifest) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return manifest;
  } finally {
    await output.close();
  }
}
