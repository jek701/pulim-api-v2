import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { database, closeDatabase } from '../../src/db/database';
import { migrateDatabase } from '../../src/db/migrate';
import {
  documentKey,
  patchDocument,
  readDocument,
  removeDocument,
  saveDocument,
} from '../../src/db/documents';
import { tables } from '../../src/db/tables';
import {
  canonical,
  typedFields,
  type ArchivedDocument,
} from '../../scripts/migration/archive-codec';
import { validateBundle, type Manifest } from '../../scripts/migration/bundle';
import { exportMysql, importMysql, verifyMysql } from '../../scripts/migration/mysql-transfer';
import { restorePlan } from '../../scripts/migration/restore-firestore';

const enabled = process.env.PULIM_MYSQL_TESTS === 'true';
describe.skipIf(!enabled)('typed import, verification and reverse migration', () => {
  let directory: string;
  let source: string;
  const originals: ArchivedDocument[] = [
    {
      path: 'cards/card-A',
      fields: typedFields({
        userId: 'u',
        balance: 100.125,
        cardType: 'debit',
        currency: 'UZS',
        legacy: { unknown: false },
      }),
    },
    {
      path: 'cards/card-a',
      fields: typedFields({ userId: 'u', balance: 0, cardType: 'credit', currency: 'USD' }),
    },
    {
      path: 'profiles/u',
      fields: typedFields({
        subscription: { tier: 'free', trialGrantedAt: 123 },
        empty: {},
        missingIsNotNull: null,
      }),
    },
    {
      path: 'deleted-parent/absent/legacy/doc',
      fields: {
        huge: { type: 'integer', value: '9223372036854775807' },
        bytes: { type: 'bytes', value: 'AP8=' },
      },
    },
  ];
  beforeAll(async () => {
    if (
      process.env.MYSQL_HOST !== '127.0.0.1' ||
      process.env.MYSQL_PORT !== '3308' ||
      process.env.MYSQL_DATABASE !== 'pulim_app_rehearsal'
    )
      throw new Error('Local rehearsal DB required');
    await migrateDatabase();
    for (const table of [
      ...Object.values(tables),
      'migration_documents',
      'migration_runs',
      'legacy_documents',
      'household_members',
    ])
      await database().deleteFrom(table).execute();
    directory = await mkdtemp(join(tmpdir(), 'pulim-transfer-'));
    source = join(directory, 'source');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(source));
    const lines = originals.map((document) => canonical(document) + '\n').join('');
    const manifest: Manifest = {
      schemaVersion: 1,
      runId: randomUUID(),
      source: { project: 'synthetic', database: 'test' },
      readTime: '2026-10-13T00:00:00.000Z',
      documents: originals.length,
      missingAncestors: 1,
      sha256: createHash('sha256').update(lines).digest('hex'),
      complete: true,
      origin: 'firestore-snapshot',
      unmappedSchemas: ['/deleted-parent/*/legacy'],
    };
    await writeFile(join(source, 'documents.ndjson'), lines, { mode: 0o600 });
    await writeFile(join(source, 'manifest.json'), canonical(manifest), { mode: 0o600 });
  }, 30000);
  afterAll(async () => {
    await closeDatabase();
    if (directory) await rm(directory, { recursive: true });
  });

  it('requires explicit unknown-collection classification before writing and resumes without duplicates', async () => {
    await expect(importMysql(source)).rejects.toThrow('UNMAPPED_COLLECTIONS_REQUIRE_REVIEW');
    expect(await database().selectFrom('cards').selectAll().execute()).toHaveLength(0);
    expect(await importMysql(source, true)).toEqual({ imported: 3, archived: 1 });
    expect(await importMysql(source, true)).toEqual({ imported: 3, archived: 1 });
    expect((await readDocument(documentKey('cards', 'card-A'))).data.balance).toBe(100.125);
  });
  it('verifies full document contents and projections, and detects corruption', async () => {
    expect(await verifyMysql(source)).toMatchObject({ ok: true, compared: 4, mismatches: 0 });
    await database()
      .updateTable('cards')
      .set({ user_id: Buffer.from('wrong') })
      .where('id', '=', Buffer.from('card-A'))
      .execute();
    expect(await verifyMysql(source)).toMatchObject({ ok: false, projectionMismatches: 1 });
    await database()
      .updateTable('cards')
      .set({ user_id: Buffer.from('u') })
      .where('id', '=', Buffer.from('card-A'))
      .execute();
    expect((await verifyMysql(source)).ok).toBe(true);
  });
  it('exports current state and creates a reverse plan containing creates, updates and deletes', async () => {
    await patchDocument(documentKey('cards', 'card-A'), { balance: 77.25 });
    await removeDocument(documentKey('cards', 'card-a'));
    await saveDocument(documentKey('userSettings', 'new-user'), { cardOrder: ['card-A'] });
    const current = join(directory, 'current');
    const exported = await exportMysql(current);
    expect((await validateBundle(current)).sha256).toBe(exported.sha256);
    const plan = await restorePlan(source, current);
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'update', path: 'cards/card-A' }),
        expect.objectContaining({ operation: 'delete', path: 'cards/card-a' }),
        expect.objectContaining({ operation: 'create', path: 'userSettings/new-user' }),
      ]),
    );
    expect(plan.actions.some((action) => action.path.includes('legacy'))).toBe(false);
    await expect(importMysql(source, true)).rejects.toThrow('RESUME_TARGET_CONFLICT');
  });
  it('refuses a bundle with a changed checksum', async () => {
    await writeFile(
      join(source, 'documents.ndjson'),
      (await readFile(join(source, 'documents.ndjson'), 'utf8')) + '\n',
    );
    await expect(validateBundle(source)).rejects.toThrow('ARCHIVE_CHECKSUM_MISMATCH');
  });
});
