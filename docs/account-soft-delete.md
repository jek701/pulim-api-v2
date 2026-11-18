# Brief: account deletion with a 30-day restore window

Repo: pulim-api-v2, branch `claude/soft-delete` (this worktree). Do NOT commit; the lead reviews and commits.

## Goal
`POST /v1/account/delete` must no longer erase data immediately. It schedules deletion:
the account is blocked at once, can be restored by the operator during 30 days, and is
erased for good (the existing full deletion) after 30 days by the worker.

## Current state (read first)
- `src/services/accountDeletion.service.ts` — `deleteAccount(uid)` → `performDeletion(uid)`: `markDeletion` (sets `profiles.data_json.$.deletionRequestedAt`), purges everything, revokes Firebase tokens, deletes the Firebase user, CRM fan-out.
- `src/db/accountDeletion.ts` — `markDeletion` (UPDATE only, COALESCE keeps the first timestamp).
- `deletionRequestedAt` is ALREADY honoured as "account is gone": `middleware/authenticate.ts:49`, `push/planner.ts:74`, `notifications/delivery.ts:97`, `telegram/context.ts:22`, `crm/facts.ts:13`, `routes/billingInternal.routes.ts:48`, `db/documents.ts:472`, `crm/deletion.ts:89`. Read each of them and confirm the behaviour is right for a *scheduled* (not yet erased) account; especially `crm/deletion.ts:89` and `db/documents.ts:472` — report what they do.
- `src/worker.ts` — standalone worker with interval loops (see `startCrmDeletionLoop`, merchant timer). Follow that pattern.

## Required changes
1. **Schedule instead of erase.** `deleteAccount(uid)` now:
   - `markDeletion(uid)` (keeps the original timestamp on retries);
   - `auth.revokeRefreshTokens(uid)` and `auth.updateUser(uid, { disabled: true })` (ignore `auth/user-not-found`);
   - returns 204 as before (the app is not changed: it signs out on 204).
   - Keep the anonymous-user 403 in the controller. Keep the safe 503 `ACCOUNT_DELETION_FAILED` wrapping.
   - No data is removed, households are untouched, CRM is NOT notified at this step (CRM facts already exclude the account).
   - Log `account.deletion_scheduled` with `uidHash` only (no raw uid, same hashing as now).
2. **Purge after 30 days.** Rename the current `performDeletion` to `purgeAccount(uid)` (exported) — unchanged logic. Add `ACCOUNT_DELETION_GRACE_DAYS` to `src/config/env.ts` (default 30, integer ≥ 0). Add a worker loop `startAccountPurgeLoop()` (new file `src/services/accountPurge.loop.ts` or similar) that every hour selects profiles whose `deletionRequestedAt` is older than the grace period (SQL on `JSON_EXTRACT(data_json,'$.deletionRequestedAt')`, batch ≤ 20 per tick) and calls `purgeAccount` for each, one at a time; errors are logged with `uidHash` and retried next tick. Start/stop it in `src/worker.ts` like `crmDeletions` (respect `stopping`, await on shutdown). Must not run when the worker is disabled (already handled by the early return).
3. **Restore.** Add `restoreAccount(uid)` in the service: refuse if the profile no longer exists (already purged) with a clear error; otherwise remove `$.deletionRequestedAt` (`JSON_REMOVE`) and `auth.updateUser(uid, { disabled: false })`. Log `account.deletion_restored` with `uidHash`.
4. **Operator CLI** `src/cli/accountDeletion.ts` + npm script `"account": "tsx src/cli/accountDeletion.ts"` (prod: also make it runnable from `dist`, e.g. `node dist/cli/accountDeletion.js`, and document both):
   - `list` — pending deletions: uid, requested date, purge date, provider and e-mail from Firebase if available (operator tool; printing to the operator's terminal is fine, never log it);
   - `find <email|uid>` — look up one account (Apple users can find the uid by their e-mail via `auth.getUserByEmail`);
   - `restore <uid>` — calls `restoreAccount`;
   - `purge <uid>` — immediate erase (for a user who asks for it now).
   Exit codes non-zero on failure.
5. **Tests** (vitest, mock DB/Firebase the way existing account-deletion tests do — find them under `tests/`): delete schedules and does not purge; repeated delete keeps the first timestamp; auth middleware rejects a scheduled account (existing behaviour, keep a test); restore clears the marker and re-enables; restore after purge fails; purge loop picks only accounts older than the grace period; update existing deletion tests to the new semantics.
6. **Docs**: short section in the repo README (or `docs/`) — how deletion works now, the CLI commands, env var.

## Constraints
- No DB migration (data_json field only). No change to the response contract.
- Keep the exhaustive `accountDeletionPolicy` intact.
- `npm run typecheck`, `npm run lint`, `npx vitest run tests/<the account deletion tests and any you touched>` must pass. 14 unrelated test files fail without env vars on untouched main too — ignore those, but list what you ran.

## Report
Write what changed (files), what the `crm/deletion.ts:89` / `db/documents.ts:472` / `authenticate.ts:49` paths do for a scheduled account, test results, and anything you were unsure about.
