# API1: account deletion — reviewed fix pass

`POST /v1/account/delete` accepts strict `{ "confirm": "DELETE" }` and returns 204 only
when SQL cleanup and Firebase deletion finish. Anonymous accounts get 403, invalid bodies
get 400, and partial cleanup gets retryable 503 `ACCOUNT_DELETION_FAILED`. Idempotency-Key
is intentionally ignored; retries execute cleanup again. Firebase user-not-found is success.
The creation-time check still protects a newer deterministic Telegram identity from an old token.

No commits, dependencies/install, new tables, migration edits, deployment or production data access.

## Review items 1–13

1. Missing profiles are accepted exactly as before, including pre-bootstrap sync capabilities.
   Only an existing deletion marker blocks non-delete routes with 409 `ACCOUNT_DELETION_IN_PROGRESS`.
2. Ordinary requests and deletion use `verifyIdToken(token, false)`. Only POST bootstrap checks
   revocation to prevent profile resurrection. Bootstrap Firebase network/internal/unknown failures
   become 503 `AUTH_UNAVAILABLE`; recognized invalid credentials retain the existing 401 handling.
   **One profile lookup per non-delete authenticated request remains necessary**: not all routes load
   a profile (notably sync capabilities), and later service reads cannot enforce the marker across
   every route before it starts. There is no cross-process marker cache. This adds no Firebase call
   to ordinary requests; document/profile write guards remain in place.
3. Household survivor changes and explicit `recordSyncChanges` upserts commit in the same SQL
   transaction, using `u:<partner>` from the retained personal owner. Candidates are selected in
   bounded pages without locks, then locked/updated by primary key. No SqlTransaction flush hooks
   run. Inspection of `src/push/outbox.ts` showed that cards/transactions can trigger planning and
   transaction budget checks, so explicit sync recording avoids that fan-out altogether.
4. Both household branches clean `createdBy` + `createdByName` and `accountOwnerId` +
   `accountOwnerName` when their paired uid is the deleted account. This covers cards, transactions,
   savings_goals and budgets, including surviving personal rows. Tests check all four entities in
   both branches for leftover uid/name values. Shared rows deleted on dissolution retain no fields.
5. Projected field deletes narrow by indexed column and retain the JSON equality predicate.
   Unindexed matches use a nonlocking SELECT of at most 1,000 primary keys, followed by DELETE
   WHERE primary-key IN (...) (full-key OR predicates for composite keys). Numeric legacy chat ids,
   pending Telegram payloads, archives and owner-summary hashes use this approach. Capture indirect
   deletes likewise select keys first. Index inventory below covers every table.
6. A second full owner sweep runs before profile removal, including relational uid/scope tables.
   Indirect capture/Telegram/archive cleanup runs again **before** this second document sweep while
   late transactions/mappings can still supply keys. Counts accumulate across both passes.
   No new general document-insert guard was added: most entity writes do not already know the
   profile marker; enforcing it there would add profile reads/locks to every write. Existing profile
   write guards remain. The requested second sweep is the mitigation; it is not a global barrier
   against arbitrarily delayed requests that passed authentication before the marker.
7. Communication campaigns survive; their author/legacy owner references are anonymised.
8. Membership or authorship alone no longer deletes another household's archive. Exact uid/name
   references are removed recursively from its typed archive, including membership entries, while
   other members and content remain. Attributable owned archives are still deleted. Scrubbing uses
   PRIMARY(path_hash) keyset pages and updates individual primary keys, without locking a scan.
9. Confirmation validation precedes the limiter. The three/hour uid limiter refunds 5xx responses
   at response completion; repeated 503 failures do not exhaust it. Tests cover four failures/retry
   and repeated invalid bodies. Existing non-5xx response counting is retained.
10. Malformed JSON gets the 400 validation envelope only on POST /v1/account/delete. Other routes
    retain main's error behaviour; tested separately.
11. capture_learning and capture_receipt_cache cleanup precedes owned transaction removal on both
    passes. Storage tests exercise both queries; orchestration tests assert their phase precedes
    each transaction sweep.
12. `accountDeletionPolicy` classifies every document entity. One explicit
    `relationalDeletionPolicy` classifies all non-document tables, and drives uid/scope cleanup.
    A test extracts tables created by src/db/migrate.ts and src/capture/migration.ts and compares
    them with the policy; new tables must receive an explicit retention decision.
13. Telegram chatId matches support JSON strings via chat_lookup plus JSON equality, and JSON
    numbers via a numeric-type-guarded SELECT followed by primary-key DELETE. Exact payload sender
    checks also work for numeric/string Telegram ids; no substring matching is used.

## Document table retention and delete indexes

`owner_date` means the existing index beginning with user_id. `family_date` begins with
household_id. All document primary keys are id. Index names describe available access paths;
actual optimizer choice has not been EXPLAINed on a live MySQL instance. Nonlocking selection
may scan when no usable secondary index exists, but the following DELETE targets primary keys.

| Table | Treatment | Delete/update access |
| --- | --- | --- |
| profiles | Special: mark `deletionRequestedAt` with UPDATE only; delete by id=uid last. | PRIMARY(id) |
| user_settings | Deleted by owner and id=uid. | owner_date(user_id); PRIMARY(id) |
| categories | Deleted by owner; shared household categories deleted on dissolution. | owner_date; family_date(household_id) |
| subcategories | Deleted by owner; shared household rows deleted on dissolution. | owner_date; family_date(household_id) |
| cards | Owner purge; shared accounts removed on dissolution; surviving personal cards lose familyAccess and deleted-account references, with sync upserts. | owner_date; family_date(household_id); family_access for survivor selection; PRIMARY(id) updates |
| transactions | Owner purge after capture cleanup; shared-account operations removed on dissolution. Partner operations keep balance/scope, lose dissolved household link and deleted-account references, with sync upserts. | owner_date; family_date(household_id); PRIMARY(id) survivor updates |
| budgets | Owner purge; shared budgets removed on dissolution; deleted-account author/owner pairs cleared on surviving member-branch rows. | owner_date; family_date(household_id); PRIMARY(id) survivor updates |
| savings_goals | Owner purge; shared goals removed on dissolution; deleted-account author/owner pairs cleared on surviving member-branch rows. | owner_date; family_date(household_id); PRIMARY(id) survivor updates |
| debts | Deleted by owner. | owner_date(user_id) |
| deposits | Deleted by owner. | owner_date(user_id) |
| subscriptions | Deleted by owner. | owner_date(user_id) |
| planned_expenses | Deleted by owner. | owner_date(user_id) |
| households | Special: owner deletion dissolves; non-owner deletion removes that member. | PRIMARY(id); household_members PRIMARY(household_id, member_index) |
| household_invites | Deleted by owner/createdBy/acceptedBy; all household invites deleted on dissolution. | owner_date; family_date(household_id); unindexed createdBy/acceptedBy → select id, PRIMARY(id) delete |
| household_invite_picks | Deleted by owner/uid; all household picks deleted on dissolution. | owner_date; family_date; unindexed uid → select id, PRIMARY(id) delete |
| telegram_users | Deleted by owner/profileUid/uid. Telegram/chat ids collected before mapping deletion. | owner_date; unindexed profileUid/uid → select id, PRIMARY(id) delete |
| telegram_login_requests | Deleted by owner/profileUid and mapped chatId. Pending unbound requests have no associated uid. | owner_date; chat_lookup(chat_id) + JSON check for strings; numeric chatId/profileUid → select id, PRIMARY(id) delete |
| phone_verifications | Deleted by owner/targetUid and Firebase phone-number document id. | owner_date; PRIMARY(id); unindexed targetUid → select id, PRIMARY(id) delete |
| shortcut_tokens | Deleted by owner. | owner_date(user_id) |
| billing_events | Special: retain event-id dedupe row; replace JSON with `{accountDeleted:true}`, clear type sidecar and user_id. No uid, order id or entitlement survives. | owner_date(user_id), UPDATE only |
| ai_chats | Deleted by owner, including the embedded message array. No separate AI message table exists. | owner_date(user_id) |
| ai_usage | Deleted by owner, including any additional diagnostics; no identifiable usage retained. | owner_date(user_id) |
| ai_feedback | Deleted by owner. | owner_date(user_id) |
| ai_forecast_cache | Deleted by owner, including plan setup caches/quotas. | owner_date(user_id) |
| fx_rates | Kept: shared exchange-rate directory. | No delete |
| telegram_updates | Deleted by owner and exact sender id inside pending serialized/legacy payloads. | owner_date; unindexed exact payload sender → select id, PRIMARY(id) delete |
| telegram_operations | Deleted by owner. | owner_date(user_id) |
| idempotency_keys | Deleted by owner. | owner_date(user_id) |
| telegram_drafts | Deleted by owner and mapped chatId. | owner_date; chat_lookup(chat_id) + JSON check for strings; numeric chatId → select id, PRIMARY(id) delete |
| telegram_sessions | Deleted by owner and mapped chat-id document key. | owner_date; PRIMARY(id) |
| telegram_messages | Deleted by owner and mapped chatId. | owner_date; chat_lookup(chat_id) + JSON check for strings; numeric chatId → select id, PRIMARY(id) delete |
| telegram_usage | Deleted by owner. | owner_date(user_id) |
| notifications | Deleted by owner. | owner_date(user_id) |
| notification_tasks | Deleted by owner. | owner_date(user_id) |
| notification_state | Deleted by owner and id=uid. | owner_date; PRIMARY(id) |
| notification_stats | Kept: aggregate channel/hour counters, no recipient content. | No delete |
| communication_campaigns | Kept as shared content; remove author uid/name (and legacy owner) instead of deleting. | Unindexed author selection without locks; PRIMARY(id) UPDATE only |
| in_app_messages | Deleted by owner (recipient). | owner_date(user_id) |
| communication_deliveries | Deleted by owner (recipient). | owner_date(user_id) |
| dev_notes | Deleted by owner, including reply threads. | owner_date(user_id) |
| dev_note_screenshots | Deleted by owner. | owner_date(user_id) |

## Relational and infrastructure retention and delete indexes

| Table | Treatment | Delete/update access |
| --- | --- | --- |
| push_devices | Delete uid, both sweeps. | push_owner_enabled(uid, disabled_at) |
| household_members | Remove deleted membership or dissolve mirror with household. | PRIMARY(household_id, member_index); member_user exists for user lookup |
| sync_entries | Delete u:uid, both sweeps. Partner upserts retained. | PRIMARY(scope, key_hash), sync_scope_seq also starts with scope |
| sync_state | Delete u:uid, both sweeps. | PRIMARY(scope) |
| capture_issued | Delete uid, both sweeps. | PRIMARY(uid, tin) |
| capture_usage | Delete uid, both sweeps. | PRIMARY(uid, month) |
| capture_refunds | Delete uid, both sweeps. | PRIMARY(uid, day) |
| merchant_user_category | Delete uid, both sweeps. | PRIMARY(uid, tin) |
| capture_owner_summary | Delete SHA-256(uid). | Nonlocking selection by owner_hash (not a leading index); delete full PRIMARY(week, owner_hash) keys |
| capture_learning | Remove hashes derivable from owned transactions before each sweep. | SELECT transaction_hash with owner_date lookup in transactions; delete PRIMARY(transaction_hash) |
| capture_receipt_cache | Remove referenced server/device keys before each sweep. | SELECT receipt_key with owner_date lookup in transactions; delete PRIMARY(receipt_key) |
| merchants | Keep shared directory. | No delete |
| merchant_category_votes | Keep aggregate weights/counts. | No delete |
| merchant_latest_votes | Keep per-merchant salted HMAC voter ids; no raw uid. | No delete |
| ikpu_category_map | Keep shared product classification directory. | No delete |
| migration_documents | Delete attributable owner copies; scrub references on survivors. | Nonlocking selection, delete PRIMARY(path_hash); keyset scrub and PRIMARY(path_hash) updates |
| legacy_documents | Same as migration_documents. | Nonlocking selection, delete PRIMARY(path_hash); keyset scrub and PRIMARY(path_hash) updates |
| migration_runs | Keep import manifest/checksums/counts. | No delete |
| schema_migrations | Keep schema metadata. | No delete |

Optional push/capture/sync/archive tables tolerate only ER_NO_SUCH_TABLE. Other storage failures
return 503; no schema fallback is attempted. Billing keeps only the event-id dedupe key and
`{accountDeleted:true}`, preventing event replay from restoring an old entitlement.

## Household and identity behaviour

Owner deletion dissolves the household, deleting shared categories, subcategories, budgets,
goals, invites/picks, cards and shared-account transactions. Partner personal operations remain
with their historical scope so analytics do not change, but lose the dissolved household link.
Balances are never reversed. Member deletion keeps the household and removes their membership
and identifying author/owner pairs. Household/mirror removal is atomic and happens last so a
failure retains the retry anchor until shared cleanup finishes.

Profile marking and bulk purges bypass write hooks; partner survivor edits record only sync
changes. Notification planners/delivery, push planning, Telegram context and campaign fan-out
skip marked accounts. Billing acknowledges absent/marked profiles without entitlement writes.
Profile updates and Telegram attachment cannot recreate missing profiles. Fresh bootstrap uses
revocation validation and seeds clean metadata/categories. Revocation happens before owner sweeps;
Firebase deletion follows profile deletion. Safe logs contain SHA-256(uid), counts and duration,
never SQL/SDK exception arguments or raw account content.

## Validation

All runs used existing dependencies; no install. `main` and HEAD were both
`cce15393230e4203aabdee86472220e12f09c9a9`. The baseline was extracted with git archive
into a temporary directory with a symlink to existing node_modules, without changing this worktree.

| Command | Result |
| --- | --- |
| npm run typecheck | Passed. |
| npm run build | Passed, including prebuild. |
| npm test | Startup blocked by EPERM writing bundled config into shared node_modules/.vite-temp. |
| npx vitest run --configLoader native | 82 files passed, 18 failed, 3 skipped; 991 tests passed, 105 skipped; 4 sandbox listen errors. |
| Same full native-loader run on untouched main | 72 files passed, identical 18 failed, 3 skipped; 957 tests passed, 105 skipped; identical 4 listen errors. |
| Full native-loader run with synthetic FIREBASE_PROJECT_ID/TELEGRAM_BOT_TOKEN, NODE_ENV=test, LOG_LEVEL=silent | 92 files passed, 8 failed, 3 skipped; 1,076 tests passed, 3 failed, 107 skipped; 6 listen errors. All 10 account files / 34 tests pass. |
| Same synthetic-env full run on untouched main | 82 files passed, identical 8 failed, 3 skipped; 1,042 tests passed, identical 3 failed, 107 skipped; identical 6 listen errors. |
| git diff --check | Passed. |

### Missing-environment failures also reproduced on untouched main

Each file below fails env validation because FIREBASE_PROJECT_ID and TELEGRAM_BOT_TOKEN are
absent (the onboarding file fails in its HTTP subsection):

- tests/notifications/format.test.ts
- tests/profile/onboardingCategories.test.ts
- tests/push/capabilities.test.ts
- tests/push/profile.test.ts
- tests/push/scheduled.test.ts
- tests/shortcut/shortcut.test.ts
- tests/telegram/client.test.ts
- tests/telegram/dispatcher.test.ts
- tests/telegram/draftFormat.test.ts
- tests/telegram/familyInvite.test.ts
- tests/telegram/loadingDraft.test.ts
- tests/telegram/loginRequest.test.ts
- tests/telegram/media.test.ts
- tests/telegram/render.test.ts

### Other baseline failures

Without synthetic env, sandbox listen EPERM causes four suites to time out:
`tests/capture/routes.test.ts`, `tests/capture/syncCapabilities.test.ts`,
`tests/devNotes/routes.test.ts`, `tests/push/routes.test.ts`.
With synthetic env, `tests/profile/onboardingCategories.test.ts` and
`tests/push/capabilities.test.ts` additionally reach the same listen restriction. Existing
assertion failures remain in `tests/telegram/media.test.ts` (two Premium handling tests) and
`tests/telegram/render.test.ts` (login keyboard). All reproduce on untouched main. No new
failing suite or assertion was introduced by this fix pass.

## Limits

All account tests use synthetic identities and mocked SQL/Firebase. No real MySQL deletion/load
benchmark was run; optimizer plans, proxy timeout and production throughput are unverified.
Batches bound writes/locks to at most 1,000 selected matches; unindexed archive/payload scans can
still be slow. The extra second sweep adds work and deliberately handles empty tables cheaply.

Frozen Firestore snapshots, exports, logs, backups and separate payment-service accounting records
remain subject to their own retention rules. Unbound login requests and receipt caches without
uid/transaction links cannot be attributed. Sanitized unlinked cache entries retain their expiry;
unlinked content-free learning hashes and salted merchant vote ids can remain. No migrations or
additional ownership storage were introduced. Ordinary Firebase token verification retains main's
no-revocation behaviour; deletion is not a global fence for all previously issued requests/tokens.
