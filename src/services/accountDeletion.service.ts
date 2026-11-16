import { rememberCrmDeletion, notifyCrmDeletion } from '../crm/deletion';
import { createHash } from 'node:crypto';
import { auth } from '../config/firebaseAuth';
import { tables, type Entity } from '../db/tables';
import {
  deleteByOwner,
  deleteByField,
  markDeletion,
  purgeRelated,
  purgeRelational,
} from '../db/accountDeletion';
import { removeAccountFromHouseholds } from './household.service';
import { logger } from '../utils/logger';
import { AppError } from '../utils/AppError';

/** Exhaustive on purpose: adding a document table requires a privacy decision. */
export const accountDeletionPolicy = {
  profiles: 'profile-last',
  userSettings: 'uid',
  categories: 'owner',
  subcategories: 'owner',
  cards: 'owner',
  transactions: 'owner',
  budgets: 'owner',
  savingsGoals: 'owner',
  debts: 'owner',
  deposits: 'owner',
  subscriptions: 'owner',
  planned_expenses: 'owner',
  households: 'household',
  householdInvites: 'invite',
  householdInvitePicks: 'uid-field',
  telegramUsers: 'mapping',
  telegramLoginRequests: 'profile-uid',
  phoneVerifications: 'target-uid',
  shortcutTokens: 'owner',
  billingEvents: 'keep-dedupe',
  aiChats: 'owner',
  aiUsage: 'owner',
  aiFeedback: 'owner',
  aiForecastCache: 'owner',
  fxRates: 'keep',
  telegramUpdates: 'owner',
  telegramOperations: 'owner',
  idempotencyKeys: 'owner',
  telegramDrafts: 'owner',
  telegramSessions: 'owner',
  telegramMessages: 'owner',
  telegramUsage: 'owner',
  notifications: 'owner',
  // CRM erasure tombstones have uid but no userId; they survive until the peer acknowledges.
  notificationTasks: 'owner',
  notificationState: 'uid',
  notificationStats: 'keep',
  communicationCampaigns: 'keep-author-anonymised',
  inAppMessages: 'owner',
  communicationDeliveries: 'owner',
  devNotes: 'owner',
  devNoteScreenshots: 'owner',
} as const satisfies Record<Entity, string>;

export async function deleteAccount(uid: string): Promise<void> {
  try {
    await performDeletion(uid);
  } catch {
    // SDK/SQL errors may embed uid, phone numbers or bound SQL values. Expose a safe retryable error.
    throw new AppError(
      503,
      'ACCOUNT_DELETION_FAILED',
      'Account deletion could not finish. Please retry.',
    );
  }
}

async function performDeletion(uid: string): Promise<void> {
  const started = Date.now();
  const counts: Record<string, number> = {};
  await markDeletion(uid);
  addCounts(counts, await purgeRelated(uid));
  try {
    const user = await auth.getUser(uid);
    if (user.phoneNumber)
      counts.phone_verifications = await deleteByField(
        'phoneVerifications',
        '__id__',
        user.phoneNumber.replace(/\D/g, ''),
      );
  } catch (error) {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
  }
  // Old ID tokens must not bootstrap the profile during a retry after SQL deletion.
  try {
    await auth.revokeRefreshTokens(uid);
  } catch (error) {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
  }
  await sweepOwnedDocuments(uid, counts);
  addCounts(counts, await removeAccountFromHouseholds(uid));
  addCounts(counts, await purgeRelational(uid));
  // Repeat indirect cleanup while late transactions/mappings still supply their keys.
  addCounts(counts, await purgeRelated(uid));
  await sweepOwnedDocuments(uid, counts);
  addCounts(counts, await purgeRelational(uid));
  const crmRemembered = await rememberCrmDeletion(uid);
  counts.profiles = await deleteByField('profiles', '__id__', uid);
  // Local data is gone and tokens are revoked. A Firebase outage must not delay CRM erasure.
  if (!crmRemembered) await notifyCrmDeletion(uid, false);
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
  }
  logger.info(
    {
      uidHash: createHash('sha256').update(uid).digest('hex'),
      counts,
      durationMs: Date.now() - started,
    },
    'account.deleted',
  );
}

async function sweepOwnedDocuments(uid: string, counts: Record<string, number>): Promise<void> {
  for (const entity of Object.keys(accountDeletionPolicy) as Entity[]) {
    const policy = accountDeletionPolicy[entity];
    if (
      ['keep', 'keep-dedupe', 'keep-author-anonymised', 'household', 'profile-last'].includes(
        policy,
      )
    )
      continue;
    counts[tables[entity]] = (counts[tables[entity]] ?? 0) + (await deleteByOwner(entity, uid));
    const field =
      policy === 'uid'
        ? '__id__'
        : policy === 'uid-field'
          ? 'uid'
          : policy === 'profile-uid'
            ? 'profileUid'
            : policy === 'target-uid'
              ? 'targetUid'
              : policy === 'invite'
                ? 'createdBy'
                : undefined;
    if (field) counts[tables[entity]] += await deleteByField(entity, field, uid);
    if (policy === 'invite')
      counts[tables[entity]] += await deleteByField(entity, 'acceptedBy', uid);
    if (policy === 'mapping') {
      counts[tables[entity]] += await deleteByField(entity, 'profileUid', uid);
      counts[tables[entity]] += await deleteByField(entity, 'uid', uid);
    }
  }
}

function addCounts(target: Record<string, number>, added: Record<string, number>): void {
  for (const [table, count] of Object.entries(added)) target[table] = (target[table] ?? 0) + count;
}
