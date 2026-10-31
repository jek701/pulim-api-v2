import { documentKey, filterQuery, queryTable, runSqlTransaction } from '../db/documents';
import { FREE_LIMITS } from '../domain/entitlements';
import {
  guestImportHash,
  guestImportMarkerId,
  planGuestImport,
  type GuestImportPayload,
  type GuestImportResult,
} from '../domain/guestImport';
import { profileRef } from '../repositories/profile.repository';
import { AppError } from '../utils/AppError';

/** Import and receipt commit together; response loss can never duplicate rows or balances. */
export async function importGuestSnapshot(
  uid: string,
  payload: GuestImportPayload,
): Promise<GuestImportResult> {
  const plan = planGuestImport(uid, payload);
  const requestHash = guestImportHash(payload);
  const markerKey = documentKey(
    queryTable('idempotencyKeys'),
    guestImportMarkerId(uid, payload.importId),
  );
  return runSqlTransaction(async (tx) => {
    const profile = await tx.read(profileRef(uid));
    if (!profile.exists) throw AppError.notFound('Profile not found.');
    const marker = await tx.read(markerKey);
    if (marker.exists) {
      if (marker.data.requestHash !== requestHash)
        throw AppError.conflict(
          'GUEST_IMPORT_CONFLICT',
          'This import id already belongs to a different snapshot.',
        );
      return marker.data.result as GuestImportResult;
    }
    const cards = await tx.read(filterQuery(queryTable('cards'), 'userId', '==', uid));
    const subscriptions = await tx.read(
      filterQuery(queryTable('subscriptions'), 'userId', '==', uid),
    );
    const subscription = profile.data.subscription as { premiumUntil?: number } | undefined;
    const premium =
      profile.data.isPremium === true &&
      typeof subscription?.premiumUntil === 'number' &&
      subscription.premiumUntil > Date.now();
    if (
      !premium &&
      (cards.size + payload.cards.length > FREE_LIMITS.cards ||
        subscriptions.size + payload.subscriptions.length > FREE_LIMITS.subscriptions)
    ) {
      throw AppError.conflict(
        'GUEST_IMPORT_LIMIT',
        'The account has no room for these guest accounts or subscriptions. Your local records have been kept.',
      );
    }
    const existing = [];
    for (const row of plan.rows)
      existing.push(await tx.read(documentKey(queryTable(row.table), row.id)));
    const settingsKey = documentKey(queryTable('userSettings'), uid);
    const settings = await tx.read(settingsKey);
    // All reads precede writes. Default categories already in the account retain their settings.
    for (let index = 0; index < plan.rows.length; index++) {
      const row = plan.rows[index];
      const current = existing[index];
      if (current.exists) {
        if (row.table !== 'categories' || current.data.userId !== uid)
          throw AppError.conflict(
            'GUEST_IMPORT_CONFLICT',
            'An imported record id is already in use.',
          );
        continue;
      }
      tx.insert(documentKey(queryTable(row.table), row.id), row.data);
    }
    const order = payload.settings?.cardOrder
      ?.map((id) => plan.result.idMap[id])
      .filter((id): id is string => Boolean(id));
    if (order?.length && !settings.exists)
      tx.save(settingsKey, { cardOrder: order, updatedAt: Date.now() });
    tx.insert(markerKey, { userId: uid, requestHash, result: plan.result, createdAt: Date.now() });
    return plan.result;
  });
}
