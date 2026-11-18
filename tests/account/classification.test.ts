import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { relationalDeletionPolicy } from '../../src/db/accountDeletion';
import { relationalTables, tables } from '../../src/db/tables';

describe('account deletion schema inventory', () => {
  it('classifies every relational/infrastructure table created by both migrations', () => {
    const migration = readFileSync('src/db/migrate.ts', 'utf8');
    const capture = readFileSync('src/capture/migration.ts', 'utf8');
    const created = new Set<string>();
    for (const match of migration.matchAll(/\.createTable\('([^']+)'\)/g)) created.add(match[1]);
    for (const match of capture.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g))
      created.add(match[1]);
    // Literal arrays used by createTable(table), such as archived document tables.
    for (const match of migration.matchAll(
      /for \(const table of \[([^\]]+)\]\) \{([\s\S]*?)\n {8}\}/g,
    )) {
      if (match[2].includes('.createTable(table)'))
        for (const literal of match[1].matchAll(/'([^']+)'/g)) created.add(literal[1]);
    }
    for (const match of migration.matchAll(/\.createTable\(relationalTables\.(\w+)\)/g))
      created.add(relationalTables[match[1] as keyof typeof relationalTables]);
    // The generic document-table loop is separately guarded by Record<Entity, ...>.
    for (const name of Object.values(tables)) created.delete(name);
    expect([...created].sort()).toEqual(Object.keys(relationalDeletionPolicy).sort());
  });
});
