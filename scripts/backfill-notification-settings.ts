import {
  StoredDocument,
  afterQuery,
  limitQuery,
  orderQuery,
  queryTable,
  readDocument,
  writeBatch,
} from '../src/db/documents';
import { closeDatabase } from '../src/db/database';
import { notificationDefaults } from '../src/notifications/settings';
const BATCH_SIZE = 400;
async function main(): Promise<void> {
  const reschedule = process.argv.includes('--reschedule');
  // Explicit rollout option: plan today's digest instead of waiting for tomorrow.
  const dueNow = process.argv.includes('--due-now');
  const now = Date.now();
  let cursor: StoredDocument | undefined;
  let scanned = 0;
  let updated = 0;
  while (true) {
    let query = limitQuery(orderQuery(queryTable('profiles'), '__id__'), BATCH_SIZE);
    if (cursor) query = afterQuery(query, cursor);
    const snapshot = await readDocument(query);
    if (snapshot.empty) break;
    const batch = writeBatch();
    for (const document of snapshot.rows) {
      scanned += 1;
      const profile = document.data;
      const patch: Record<string, unknown> = {};
      if (typeof profile.createdAt !== 'number')
        patch.createdAt = Number(profile.updatedAt ?? Date.now());
      if (!profile.notifications) {
        const defaults = notificationDefaults(profile, now);
        if (dueNow) defaults.nextDailyAt = now;
        patch.notifications = defaults;
      } else if ((reschedule || dueNow) && profile.notifications.enabled) {
        patch['notifications.nextDailyAt'] = dueNow ? now : notificationDefaults(profile, now).nextDailyAt;
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = Date.now();
        batch.patch(document.key, patch);
        updated += 1;
      }
    }
    await batch.commit();
    cursor = snapshot.rows[snapshot.rows.length - 1];
    if (snapshot.size < BATCH_SIZE) break;
  }
  console.log(
    `Notification backfill complete: scanned=${scanned}, updated=${updated}, reschedule=${reschedule}, dueNow=${dueNow}`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
