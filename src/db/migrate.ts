import { sql } from 'kysely';
import { database, closeDatabase } from './database';
import { tables } from './tables';
import { projections } from './documents';

/** Additive and restartable: DDL is not transactional on MySQL. Never drops data. */
export async function migrateDatabase(): Promise<void> {
  await database()
    .connection()
    .execute(async (db) => {
      const lock = await sql<{
        acquired: number;
      }>`SELECT GET_LOCK(CONCAT(DATABASE(), ':pulim_schema'), 30) AS acquired`.execute(db);
      if (Number(lock.rows[0]?.acquired) !== 1)
        throw new Error('Schema migration lock unavailable');
      try {
        for (const table of Object.values(tables)) {
          let schema = db.schema
            .createTable(table)
            .ifNotExists()
            .addColumn('id', sql`VARBINARY(2048)`, (column) => column.primaryKey())
            .addColumn('data_json', 'json', (column) => column.notNull())
            .addColumn('types_json', 'json', (column) => column.notNull());
          for (const column of Object.values(projections)) {
            schema = schema.addColumn(
              column,
              column.endsWith('_ms')
                ? sql`BIGINT`
                : sql`VARBINARY(${sql.lit(column === 'status' ? 64 : 2048)})`,
            );
          }
          schema = schema.addColumn('expires_at_ms', 'bigint');
          await schema.execute();
          // Check existing indexes, since MySQL lacks CREATE INDEX IF NOT EXISTS.
          const indexes = await sql<{
            INDEX_NAME: string;
          }>`SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}`.execute(
            db,
          );
          const existing = new Set(indexes.rows.map((row) => row.INDEX_NAME));
          const definitions: Record<string, string[]> = {
            owner_date: ['user_id', 'date_ms', 'created_at_ms'],
            family_date: ['household_id', 'date_ms', 'created_at_ms'],
            queue_attempt: ['status', 'next_attempt_at_ms'],
            queue_lease: ['status', 'lease_until_ms'],
            queue_run: ['status', 'run_at_ms'],
            daily_due: ['next_daily_at_ms'],
            family_access: ['family_household_id'],
            chat_lookup: ['chat_id'],
            username_lookup: ['username'],
          };
          for (const [name, columns] of Object.entries(definitions)) {
            if (!existing.has(name))
              await db.schema.createIndex(name).on(table).columns(columns).execute();
          }
        }
        await db.schema
          .createTable('schema_migrations')
          .ifNotExists()
          .addColumn('version', 'varchar(64)', (column) => column.primaryKey())
          .addColumn('applied_at', 'datetime', (column) => column.notNull())
          .execute();
        await db.schema
          .createTable('migration_runs')
          .ifNotExists()
          .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
          .addColumn('manifest_json', 'json', (column) => column.notNull())
          .addColumn('status', 'varchar(32)', (column) => column.notNull())
          .addColumn('updated_at', 'datetime', (column) => column.notNull())
          .execute();
        for (const table of ['migration_documents', 'legacy_documents']) {
          await db.schema
            .createTable(table)
            .ifNotExists()
            .addColumn('path_hash', 'char(64)', (column) => column.primaryKey())
            .addColumn('path', 'text', (column) => column.notNull())
            .addColumn('run_id', 'varchar(64)', (column) => column.notNull())
            .addColumn('archive_json', 'json', (column) => column.notNull())
            .execute();
        }
        await db.schema
          .createTable('household_members')
          .ifNotExists()
          .addColumn('household_id', sql`VARBINARY(2048)`, (column) => column.notNull())
          .addColumn('member_index', 'integer', (column) => column.notNull())
          .addColumn('user_id', sql`VARBINARY(2048)`, (column) => column.notNull())
          .addPrimaryKeyConstraint('household_member_pk', ['household_id', 'member_index'])
          .execute();
        const memberIndexes = await sql<{
          INDEX_NAME: string;
        }>`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'household_members' AND INDEX_NAME = 'member_user'`.execute(
          db,
        );
        if (!memberIndexes.rows.length)
          await db.schema
            .createIndex('member_user')
            .on('household_members')
            .column('user_id')
            .execute();
        await db
          .insertInto('schema_migrations')
          .values({ version: '001_document_tables', applied_at: new Date() })
          .onDuplicateKeyUpdate({ version: '001_document_tables' })
          .execute();
      } finally {
        await sql`SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':pulim_schema'))`.execute(db);
      }
    });
}
if (require.main === module) {
  void migrateDatabase()
    .then(() => console.log('Schema migrations complete'))
    .catch(() => {
      console.error('Schema migration failed');
      process.exitCode = 1;
    })
    .finally(closeDatabase);
}
