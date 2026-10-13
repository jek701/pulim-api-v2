import { parseArgs } from 'node:util';
import { closeDatabase } from '../../src/db/database';
import { migrateDatabase } from '../../src/db/migrate';
import { exportFirestore } from './export-firestore';
import { exportMysql, importMysql, verifyMysql } from './mysql-transfer';
import { verifyFrozenSource } from './verify-frozen-source';
import { applyRestore, writeRestorePlan } from './restore-firestore';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      database: { type: 'string' },
      directory: { type: 'string' },
      source: { type: 'string' },
      current: { type: 'string' },
      out: { type: 'string' },
      'target-database': { type: 'string' },
      'archive-unknown': { type: 'boolean' },
      'reviewed-plan': { type: 'string' },
      apply: { type: 'boolean' },
      'writers-stopped': { type: 'boolean' },
      'apply-deletes': { type: 'boolean' },
      'recovery-database': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      'Explicit migration tools; no .env is loaded automatically.\nCommands: export-firestore, import-mysql, verify, export-mysql, restore-plan, restore-firestore\nUse --directory for bundles, --project/--database for Firestore, --target-database matching MYSQL_DATABASE for SQL.\nRestore writes require --apply --writers-stopped --reviewed-plan and explicit delete/recovery mode.',
    );
    return;
  }
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== 'string' || !value) throw new Error('REQUIRED_ARGUMENT_MISSING');
    return value;
  };
  if (['import-mysql', 'verify', 'export-mysql'].includes(command)) {
    if (required('target-database') !== process.env.MYSQL_DATABASE)
      throw new Error('TARGET_DATABASE_MISMATCH');
  }
  switch (command) {
    case 'verify-source-frozen': {
      const result = await verifyFrozenSource(required('directory'));
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'export-firestore': {
      const result = await exportFirestore(
        required('project'),
        required('database'),
        required('directory'),
      );
      console.log(
        JSON.stringify({
          runId: result.runId,
          documents: result.documents,
          missingAncestors: result.missingAncestors,
          unknownSchemas: result.unmappedSchemas.length,
        }),
      );
      break;
    }
    case 'import-mysql':
      await migrateDatabase();
      console.log(
        JSON.stringify(await importMysql(required('directory'), values['archive-unknown'])),
      );
      break;
    case 'verify': {
      const result = await verifyMysql(required('directory'));
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'export-mysql': {
      const result = await exportMysql(required('directory'));
      console.log(JSON.stringify({ runId: result.runId, documents: result.documents }));
      break;
    }
    case 'restore-plan': {
      const plan = await writeRestorePlan(required('source'), required('current'), required('out'));
      console.log(
        JSON.stringify({
          actions: plan.actions.length,
          creates: plan.actions.filter((a) => a.operation === 'create').length,
          updates: plan.actions.filter((a) => a.operation === 'update').length,
          deletes: plan.actions.filter((a) => a.operation === 'delete').length,
        }),
      );
      break;
    }
    case 'restore-firestore': {
      if (!values.apply) throw new Error('USE_RESTORE_PLAN_BEFORE_APPLY');
      console.log(
        JSON.stringify({
          applied: await applyRestore({
            source: required('source'),
            current: required('current'),
            reviewedPlan: required('reviewed-plan'),
            project: required('project'),
            database: required('database'),
            writersStopped: values['writers-stopped'] ?? false,
            applyDeletes: values['apply-deletes'] ?? false,
            recoveryDatabase: values['recovery-database'] ?? false,
          }),
        }),
      );
      break;
    }
    default:
      throw new Error('UNKNOWN_MIGRATION_COMMAND');
  }
}
void main()
  .catch((error: unknown) => {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'MIGRATION_COMMAND_FAILED';
    console.error(code);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
