import 'dotenv/config';
import type { UserRecord } from 'firebase-admin/auth';
import { auth } from '../config/firebaseAuth';
import { env } from '../config/env';
import { closeDatabase } from '../db/database';
import { listPendingAccountDeletions } from '../db/accountDeletion';
import { documentKey, readDocument } from '../db/documents';
import { purgeAccount, restoreAccount } from '../services/accountDeletion.service';
import { AppError } from '../utils/AppError';

async function firebaseUser(uid: string): Promise<UserRecord | undefined> {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
    return undefined;
  }
}

function accountInfo(uid: string, requestedAt: number | undefined, user?: UserRecord) {
  return {
    uid,
    requestedAt: requestedAt === undefined ? null : new Date(requestedAt).toISOString(),
    purgeAt: requestedAt === undefined ? null : new Date(requestedAt + env.ACCOUNT_DELETION_GRACE_DAYS * 86400000).toISOString(),
    provider: user ? [...new Set([
      ...user.providerData.map((provider) => provider.providerId),
      ...(typeof user.customClaims?.provider === 'string' ? [user.customClaims.provider] : []),
    ])] : [],
    email: user?.email ?? null,
  };
}

export async function runAccountDeletionCli(args: string[]): Promise<void> {
  const [command, value] = args;
  const print = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  if (command === 'list' && args.length === 1) {
    const accounts = [];
    for (const { uid, requestedAt } of await listPendingAccountDeletions())
      accounts.push(accountInfo(uid, requestedAt, await firebaseUser(uid)));
    print(accounts);
    return;
  }
  if (command === 'find' && value && args.length === 2) {
    const user = value.includes('@') ? await auth.getUserByEmail(value) : await firebaseUser(value);
    const uid = user?.uid ?? value;
    const profile = await readDocument(documentKey('profiles', uid));
    if (!user && !profile.exists) throw AppError.notFound('Account not found.');
    print(accountInfo(uid, profile.data?.deletionRequestedAt, user));
    return;
  }
  if ((command === 'restore' || command === 'purge') && value && args.length === 2) {
    await (command === 'restore' ? restoreAccount(value) : purgeAccount(value));
    print({ uid: value, action: command, success: true });
    return;
  }
  throw new Error('Usage: account list | find <email|uid> | restore <uid> | purge <uid>');
}

if (require.main === module) {
  void runAccountDeletionCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(error instanceof AppError ? `${error.message}\n` : 'Account command failed; check arguments, Firebase and database readiness.\n');
    process.exitCode = 1;
  }).finally(closeDatabase);
}
