import 'dotenv/config';
import { closeDatabase } from '../db/database';
import { reviewMerchants, verifyMerchant } from '../capture/owner';
import { STANDARD_CATEGORY_KEYS } from '../capture/categories';

export async function runMerchantsCli(args: string[]): Promise<void> {
  const [command, tin, standardKey] = args;
  if (command === 'review' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(await reviewMerchants(), null, 2)}\n`);
    return;
  }
  if (command === 'verify' && args.length === 3) {
    await verifyMerchant(tin, standardKey);
    process.stdout.write(`${JSON.stringify({ tin, standardKey, verified: true })}\n`);
    return;
  }
  throw new Error(`Usage: merchants review | verify <tin> <standardKey> (${STANDARD_CATEGORY_KEYS.join(', ')})`);
}

if (require.main === module) {
  void runMerchantsCli(process.argv.slice(2)).catch(() => {
    process.stderr.write('Merchant command failed; check arguments and database readiness.\n');
    process.exitCode = 1;
  }).finally(closeDatabase);
}
