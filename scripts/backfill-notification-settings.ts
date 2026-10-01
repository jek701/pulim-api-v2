import { admin, db } from '../src/config/firebase';
import { notificationDefaults } from '../src/notifications/settings';

const BATCH_SIZE = 400;

async function main(): Promise<void> {
  const reschedule = process.argv.includes('--reschedule');
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let scanned = 0;
  let updated = 0;
  while (true) {
    let query = db.collection('profiles').orderBy(admin.firestore.FieldPath.documentId()).limit(BATCH_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    const batch = db.batch();
    for (const document of snapshot.docs) {
      scanned += 1;
      const profile = document.data();
      const patch: Record<string, unknown> = {};
      if (typeof profile.createdAt !== 'number') patch.createdAt = Number(profile.updatedAt ?? Date.now());
      if (!profile.notifications) patch.notifications = notificationDefaults(profile);
      else if (reschedule && profile.notifications.enabled) {
        patch['notifications.nextDailyAt'] = notificationDefaults(profile).nextDailyAt;
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = Date.now();
        batch.update(document.ref, patch);
        updated += 1;
      }
    }
    await batch.commit();
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < BATCH_SIZE) break;
  }
  console.log(`Notification backfill complete: scanned=${scanned}, updated=${updated}, reschedule=${reschedule}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(admin.apps.map((app) => app?.delete()));
  });
