import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = (values: Record<string, string>) => promisify(execFile)(process.execPath, [
  '--import', require.resolve('tsx'), '--eval',
  `const { env } = require(${JSON.stringify(resolve('src/config/env.ts'))}); console.log(JSON.stringify([env.PULIM_CRM_INTERNAL_SECRET, env.PULIM_CRM_API_URL]));`,
], { env: { DOTENV_CONFIG_PATH: '/dev/null', FIREBASE_PROJECT_ID: 'test', TELEGRAM_BOT_TOKEN: 'test', ...values }, timeout: 15000 });

describe('optional CRM environment variables', () => {
  it.each(['', '   '])('treats blank values %j as unset', async (value) => {
    const { stdout } = await run({ PULIM_CRM_INTERNAL_SECRET: value, PULIM_CRM_API_URL: value });
    expect(JSON.parse(stdout)).toEqual([null, null]);
  });
  it('accepts valid values and rejects invalid nonblank values', async () => {
    const secret = 'x'.repeat(32);
    const url = 'https://crm.example.test';
    expect(JSON.parse((await run({ PULIM_CRM_INTERNAL_SECRET: secret, PULIM_CRM_API_URL: url })).stdout)).toEqual([secret, url]);
    await expect(run({ PULIM_CRM_INTERNAL_SECRET: 'short' })).rejects.toThrow();
    await expect(run({ PULIM_CRM_API_URL: 'invalid' })).rejects.toThrow();
  });
});
