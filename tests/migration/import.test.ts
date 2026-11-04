import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('migration CLI imports', () => {
  it('imports with only MYSQL variables and never loads application env', async () => {
    // An empty cwd also prevents a regression from reading a developer dotenv file.
    const cwd = await mkdtemp(join(tmpdir(), 'pulim-migration-import-'));
    try {
      const result = await promisify(execFile)(process.execPath, [
        '--import', require.resolve('tsx'), '--eval',
        `import(${JSON.stringify(resolve('src/db/migrate.ts'))}).then(() => console.log('imported'))`,
      ], {
        cwd,
        env: { MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '3308', MYSQL_USER: 'test', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'test' },
        timeout: 15_000,
      });
      expect(result.stdout.trim()).toBe('imported');
      expect(result.stderr).toBe('');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
