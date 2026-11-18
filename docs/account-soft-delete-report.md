# Account soft deletion implementation report

No commits or deployment were made. The supplied brief is unchanged.

## Changes

- `src/services/accountDeletion.service.ts`: scheduling only marks, revokes refresh
  tokens and disables Firebase; missing Firebase users are tolerated and failures
  retain the safe 503 envelope. Exports the original purge unchanged as
  `purgeAccount`, plus `restoreAccount`. Schedule/restore logs contain only uidHash.
- `src/db/accountDeletion.ts`: numeric-marker pending selection, optional cutoff
  and limit; locked profile-existence check and JSON_REMOVE for restore. Existing
  UPDATE/COALESCE timestamp preservation and exhaustive policies remain intact.
- `src/services/accountPurge.loop.ts`, `src/worker.ts`: immediate/hourly ticks,
  maximum 20 eligible profiles, sequential purges, hashed failure logs, no
  overlapping ticks, stop further accounts on shutdown and await the active run.
- `src/config/env.ts`: ACCOUNT_DELETION_GRACE_DAYS, integer >= 0, default 30.
- `src/cli/accountDeletion.ts`, `package.json`: account list/find/restore/purge,
  Firebase email lookup, operator-only terminal details, nonzero exit on failure;
  compiled entrypoint is dist/cli/accountDeletion.js.
- `README.md`, `docs/ai/api.md`: lifecycle, operator commands, production commands,
  configuration and recovery notes. Billing route comment now describes the
  preserved scheduled-account guard accurately.
- `tests/account/deletion.test.ts`, `storage.test.ts`, new `cli.test.ts` and
  `purgeLoop.test.ts`: schedule/restore/purge, timestamp SQL, cutoff/batch SQL,
  operator commands, sequential retries and loop shutdown. Updated
  `tests/push/shutdown.test.ts` to await the new loop; replaced eight literal
  regex spaces with {8} in `tests/account/classification.test.ts` to satisfy lint.

## Existing marker guards reviewed

- `src/middleware/authenticate.ts:49`: rejects marked profiles with 409
  ACCOUNT_DELETION_IN_PROGRESS on ordinary routes. The authenticated deletion
  route remains available for retries; bootstrap also checks Firebase revocation.
- `src/db/documents.ts:472`: rejects profile inserts/updates/patches when the
  existing profile has the marker. This prevents profile changes or bootstrap
  from clearing it. Operator restore deliberately uses direct JSON_REMOVE.
- `src/crm/deletion.ts:89`: a pending CRM tombstone is deferred while the marked
  profile exists; it does not send erasure. If the marker has been removed,
  the tombstone is dropped to protect the active/restored account. CRM sends
  erasure only when the profile is absent. Scheduling creates no tombstone.
- `src/push/planner.ts:74`: skips planning for marked profiles.
- `src/notifications/delivery.ts:97`: finishes claimed notifications as skipped
  (disabled) for marked profiles, rather than delivering them.
- `src/telegram/context.ts:22`: returns no user context for a marked profile.
- `src/crm/facts.ts:13`: excludes marked profiles from registered CRM facts.
- `src/routes/billingInternal.routes.ts:48`: acknowledges billing events without
  profile or event writes while marked. Restoration does not replay these events.

## Verification

Passed: npm run typecheck, npm run lint, npm run build, git diff --check.

Focused command:

```sh
npx vitest run --configLoader native tests/account tests/crm/deletion.test.ts tests/push/shutdown.test.ts
```

14 files, 66 tests passed. This includes existing HTTP contract tests (204,
anonymous 403, safe 503), authentication rejection and CRM fan-out tests.

The native config loader avoids a sandbox EPERM writing Vite's temporary config
into the shared node_modules directory. Full command `npm test -- --configLoader
native`: 92 files passed, 18 failed, 3 skipped; 1074 tests passed, 105 skipped.
The failures comprise 14 files missing required environment and four HTTP files
blocked by sandbox local-port restrictions (four unhandled listen EPERM errors).
No live Firebase/MySQL integration or destructive command ran.

## Review notes

The purge body was preserved exactly as requested. Its existing final Firebase
user deletion happens after profile removal: a failure at that point has no
profile marker left for the SQL worker to select on its next tick. An operator
can retry `purge <uid>`; a durable retry across that boundary would require a
separate change to the requested purge design.

Restore clears the SQL marker before re-enabling Firebase, as specified. If
Firebase fails, rerun restore. Operator restore and automatic purge are not
serialized across the entire destructive operation; avoid restoring an account
once its purge has begun. The default operator recovery window is the 30 days
before eligibility, with hourly worker timing thereafter.
