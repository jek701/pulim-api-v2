# pulim-api-v2 — main backend (deep reference)

Repo: `~/WebstormProjects/pulim-api-v2` (git `jek701/pulim-api-v2`, work on `main`). Snapshot 2026-10-21, HEAD `3887c5c` (2026-10-17).
Prod: `https://api.m-pulim.uz` → nginx → 127.0.0.1:**3111**; pm2 `pulim-api` (dist/server.js) + `pulim-worker` (dist/worker.js), `/root/pulim-api-v2`.
Also hosts the **Telegram bot** (webhook) and background worker. Related: [overview](overview.md), [pulim-ui-v2 → docs/ai/ui.md](../../../pulim-ui-v2/docs/ai/ui.md), [pulim-payment-api → docs/ai/payments.md](../../../pulim-payment-api/docs/ai/payments.md), [workflow](workflow.md).
**Code is the source of truth**: `docs/TZ-*.md`, README parts and some comments still describe Firestore.

## Stack
Node ≥24 (prod 24.15 via nvm), TS 5.7 strict → CommonJS, **Express 5**, helmet, cors, express-rate-limit, pino, zod 3, dayjs.
Storage **MySQL 8 via Kysely + mysql2** (db `pulim_app`). `firebase-admin` only for **Auth** (verify ID tokens, custom tokens, claims).
`openai` SDK v6 Responses API (server-side only). `@google-cloud/firestore` remains only for migration scripts.
Scripts: `dev`, `dev:worker`, `build`, `start`, `worker`, `typecheck`, `lint`, `format`, `test` (vitest), `test:mysql` (destructive, only against local 127.0.0.1:3308 `pulim_app_rehearsal`, `PULIM_MYSQL_TESTS=true`),
`db:migrate`, `db:migrate:prod`, `backfill:notifications`, `data:*` migration tools.
Verify before commit: `npm run typecheck && npm test && npm run build`.

Processes: `server.ts` refuses to start unless `schema_migrations` has `001_document_tables`; registers Telegram webhook, FX retry queue (60 s), Telegram update recovery (30 s).
`worker.ts`: notification planner (15 min), delivery (5 s), communications dispatch (30 s). **Exactly one worker.** No cron in-app.
Modes: `MAINTENANCE_MODE=true` (503 except /health), `BACKGROUND_JOBS_ENABLED=false`, `NOTIFICATIONS_ENABLED=false`, `NOTIFY_EMBEDDED`.

## Layout (`src/`)
`app.ts`, `server.ts`, `worker.ts`, `config/` (env.ts zod, firebaseAuth.ts), `db/` (database, **tables.ts** entity→table map, **documents.ts** query/tx layer, **values.ts** codec + patch ops, migrate.ts),
`domain/` (types, schemas (all zod), entitlements, trial, **balance.ts**, debt, deposit, billing, recurrence, defaultCategories, authMetadata),
`middleware/` (authenticate, requirePremium, enforceLimit, validate, rateLimit, errorHandler), `routes/` (index.ts mounts all), `controllers/` (crud.ts factory),
`services/` (transaction, card, debt, deposit, savings, subscription, household, profile, entitlement, ai, fxRates, shortcut, telegramAuth, telegramVerify, phoneAuth, eskiz),
`repositories/`, `telegram/` (dispatcher, handlers, **quickEntry.service.ts** ~1460 lines, parser.service (LLM), resolve/{amount,date,category,card}, media, fxQueue, i18n),
`notifications/` (planner, delivery, collectors, render, schedule, ai), `communications/`, `devNotes/`, `prompts/` (chatSystem, buildContext), `cli/devNotes.ts`, `utils/` (AppError, asyncHandler, logger).

## Storage: "document store on MySQL" (CRITICAL)
Firestore→MySQL cutover done **2026-10-13 ~23:52 Tashkent** (`docs/mysql-cutover.ru.md`, `docs/mysql-migration-progress.ru.md`), 3242 docs / 28 collections, 0 mismatches.
Firestore source frozen & kept for recovery; **no runtime Firestore use**. Firebase Auth still used (same uids).
Every entity table has the same generic schema: `id VARBINARY(2048)` (old doc id), `data_json JSON`, `types_json JSON` (type sidecar: timestamp, int64, …),
plus **projection columns** auto-filled from data_json (user_id, household_id, card_id, category_id, linked_transaction_id, chat_id, username, status, created_at_ms, updated_at_ms, date_ms, run_at_ms, next_attempt_at_ms, lease_until_ms, scheduled_at_ms, next_daily_at_ms, family_household_id, expires_at_ms) and the same 9 indexes.
Extra: `schema_migrations`, `migration_*`, `legacy_documents`, `household_members` (mirror of memberIds).
- Queries: `queryTable/filterQuery/orderQuery/limitQuery/afterQuery/countQuery` → `readDocument`. Ops `== < <= > >= in array-contains`, evaluated on `JSON_EXTRACT` with **strict JSON type guard** (Firestore semantics). Ordering by a field excludes docs lacking it.
- **Unsigned-timestamp gotcha (fixed in 3887c5c):** MySQL may report epoch-ms as `JSON_TYPE='UNSIGNED INTEGER'`; numeric guard must include `'INTEGER','UNSIGNED INTEGER','DOUBLE'` (`src/db/documents.ts:160`). Before the fix notifications never planned/delivered.
- `runSqlTransaction(work)`: REPEATABLE READ, UTC, reads `FOR UPDATE`, writes buffered; **all reads before first write** (else "Read all records before scheduling writes"); retried up to 5× on deadlock → **no external side effects inside**.
- `patch` dotted keys = field paths; `save({merge:true})` dotted keys literal. `patchValue.delete/increment/arrayUnion/arrayRemove` emulate FieldValue.
- No SQL FKs; relations live in JSON. Business timestamps = epoch ms numbers. No TTL cleanup job for `expires_at_ms` (retention undecided).
- Adding a queryable field = add a projection in `db/documents.ts` (affects all tables). Don't add relational columns/joins casually.

Key tables (`src/db/tables.ts`, 40): profiles (id = uid; Telegram users `tg_<telegramId>`), user_settings, categories (defaults `${uid}__default__${type}_${slug}`), subcategories,
cards, transactions (Telegram ids `telegram_<sha>`), budgets (`${uid}_${categoryId}`), savings_goals, debts, deposits, subscriptions, planned_expenses,
households, household_invites (7-day token), household_invite_picks, telegram_users, telegram_login_requests (bot login, 5-min, hashes only), phone_verifications (HMAC of code), shortcut_tokens (sha256), billing_events, fx_rates,
ai_chats, ai_usage, ai_feedback, ai_forecast_cache, telegram_updates/operations/drafts/sessions/messages/usage, notifications, notification_tasks/state/stats,
communication_campaigns, in_app_messages, communication_deliveries, dev_notes, dev_note_screenshots.

## Auth
All `/v1/*`: `Authorization: Bearer <Firebase ID token>` → `req.uid`. Ownership via `readOwned`/`userScopedRepo` (403 wrong owner, 404 missing).
- **Telegram Mini App** `POST /auth/telegram {telegramInitData, chatId, language?, firebaseIdToken?}`: HMAC check with bot token (Ed25519 fallback); creates `tg_<id>` account + profile + default categories or resolves mapping; custom claims `{provider:'telegram', telegramId}`; returns customToken. With firebaseIdToken = link to existing account.
- **Native app via bot deep link** `POST /auth/telegram/login-request` → `t.me/<bot>?start=login_<nonce>` → bot `/start login_…` approves (same `signInTelegramUser` as the Mini App) → app polls `POST /auth/telegram/login-request/:requestId/exchange {deviceSecret}` for a one-time customToken. Contract: [docs/telegram-bot-login.md](../telegram-bot-login.md).
- **Phone (Eskiz SMS)** `POST /auth/phone/send-code`, `/auth/phone/verify`: +998 only, 6-digit code, HMAC with `PHONE_CODE_PEPPER`, TTL/cooldown/attempt limits; `purpose:'link'` attaches phone to current uid. Replaced Firebase phone auth.
- Email/Google/Apple: native Firebase client; API only records metadata on `POST /v1/profile/bootstrap`.
- Owner-only: `DEV_NOTES_UIDS` gates dev notes + communications admin (others get 404). `NOTIFY_ALLOWED_UIDS` = notification rollout allowlist.
- Machine: billing HMAC, Telegram `X-Telegram-Bot-Api-Secret-Token`, Shortcut personal key.

## Endpoints
Errors `{error:{code,message,details?}}`; zod → 400 `VALIDATION_ERROR`; free-plan → 403 `LIMIT_REACHED` / `PREMIUM_REQUIRED`.
Public: `GET /health`, `/health/live`, `/health/ready`; `POST /auth/telegram`; `POST /auth/telegram/login-request`, `POST /auth/telegram/login-request/:requestId/exchange`, `GET /auth/telegram/app-return`; `POST /auth/phone/send-code|verify`; `POST /telegram/webhook`; `POST /internal/v1/billing/events`;
`GET /shortcut/v1/cards`, `GET /shortcut/v1/categories`, `POST /shortcut/v1/expenses` (plain-text replies).
`/v1` (auth):
- profile: `POST /profile/bootstrap`, `POST /profile/trial/start`, `GET|PATCH /profile`, `PATCH /profile/home-widgets`, `POST /profile/telegram-link-dismissed`, `PATCH /profile/notifications {enabled}`; `GET|PATCH /settings`
- `categories`, `subcategories` (GET/POST/DELETE; custom = Premium)
- `cards` GET/POST(limit)/PATCH/DELETE, `POST /cards/refill {creditCardId, sourceCardId, amount}`
- `budgets` GET, `PUT /:categoryId` (Premium), DELETE; special ids `__income__`, `__debts__`, `__subscription__`
- `savings-goals` + `/:id/contribute`; `subscriptions` + `/:id/pay` (expense with `categoryId '__subscription__'`, advances nextBillingDate); `planned-expenses` + `/:id/settle` (Mark paid/received: normal transaction of the plan `kind`, balance like subscription pay, `paid[day]=txId`; `paid` is server-only, plan also has optional `accountId`, `skipped[]`; `409 ALREADY_SETTLED`; not Premium-gated)
- `transactions`: GET (all, **no pagination**), POST, PATCH/DELETE `/:id`, DELETE all (clear data, **does not reverse balances**), `POST /transfer`, `PATCH /:id/transfer`, `POST|PATCH /:id/return`
- `debts` + `/:id/pay`; `deposits` + `/:id/collect-interest|close|replenish|withdraw`
- AI: `POST /ai/forecast` (cached 15 min), `POST /ai/chat` (SSE: meta, delta, done, error), `POST /ai/feedback`, `GET|PATCH|DELETE /ai-chats`. No key → 503 `AI_UNAVAILABLE`.
- households: `GET /households/current`, `POST /households`, `PATCH /households/current` (owner), invites (`POST /current/invites`, `GET /current/invites/:token`, `/pick`, `/share`, `GET /households/invites/:token`, `POST .../accept`),
  `/current/categories`, `/current/budgets`, `/current/cards` (+ `/:id/access {enabled, showBalance}`), `/current/goals` (+ contribute), `/current/transactions`. Error messages here are Russian.
- dev notes: `GET /dev-notes/access`, `GET|POST /dev-notes`, `GET /:id/screenshot`, `POST /:id/replies`, `DELETE /:id`
- communications: `GET|PATCH /communications/preferences`, `GET /communications/inbox`, `POST /inbox/:id/{read|click|dismiss}`, admin `GET /admin/access`, `GET|POST /admin/campaigns`, `PATCH /:id`, `POST /:id/send|pause`
- `GET|POST|DELETE /shortcut-token` (POST Premium, plain key returned once)

## Money invariants
- **Single balance rule** `domain/balance.ts balanceDelta(cardType, txType, amount)`: credit card `balance` = debt used (expense adds); debit/cash = real money.
- Balances are **stored**, never recomputed from history. Every money op is one `runSqlTransaction` (tx row + balance together).
- System ops carry `source` ∈ transfer, return, debt_payment, savings, deposit_interest, deposit_close, deposit_replenish, deposit_withdraw, subscription (+ `sourceLabel`, categoryId usually ''). Generic PATCH rejects them → use dedicated endpoints. Stats ignore transfers.
- Transfer = one tx (`type:'expense'`, cardId, toCardId, toAmount, toCurrency), two balance moves; cross-currency needs toAmount.
- Return = income row with `linkedTransactionId`, increments original `returnedAmount`; only expenses; capped; same currency; deleting original deletes refunds.
- FX: `baseAmount`, `fxRate`, `fxRateSource` (NBU|manual); rates from cbu.uz (called "NBU" in code), cached in `fx_rates`, refreshed 6 h. Currencies UZS, USD, EUR, RUB, GBP, CNY, KZT, TRY, AED, JPY.
- Deleting a card/debt/deposit does NOT reverse related transactions.

## Premium / trial
`FREE_LIMITS` (`domain/entitlements.ts`): 1 debit card, 2 subscriptions, 1 AI chat, 10 AI msgs/30 days. Premium AI fair-use `AI_PREMIUM_MESSAGES_PER_PERIOD` (500).
Premium-only: custom categories, budgets, debts, deposits, savings, planned, Shortcut, Telegram voice/receipt.
`getIsPremium` = `isPremium === true && subscription.premiumUntil > now`. `profile.subscription` = Premium; `subscriptions` table = user's bills (don't confuse).
Trial: explicit `POST /v1/profile/trial/start`, once, 7 days, `source:'trial'`; blocked after any paid history.
Paid Premium only via billing webhook (contract + flow in [pulim-payment-api → docs/ai/payments.md](../../../pulim-payment-api/docs/ai/payments.md)): headers `x-pulim-event-id`, `x-pulim-timestamp`, `x-pulim-signature`; secret `PULIM_PAYMENT_INTERNAL_SECRET`; dedupe `billing_events`; apply if `version > subscription.billingVersion`; accepts only `source ∈ {atmos, none}`, `isTrial:false`. Never replay the old DEAD trial event in payment outbox; never roll back payment DB with app DB.

## Households (family)
Max 2 members (owner + partner), no leave/remove endpoint. Invite token 7 days, link `https://t.me/<bot>?startapp=family_<token>`; delivery via Telegram contact picker (`request_users`, 20 picks/day) or prepared inline message.
Household rows: `scope:'household'`, `householdId`, `userId:'household:<hid>'` for shared accounts; family tx from a personal card has `userId` = card owner → appears in owner's personal list but read-only there.
Personal card shared via `familyAccess{householdId, enabled, showBalance}`; hidden balance returns `balance:0, balanceHidden:true`. Shared goals are canonical household rows.

## Telegram bot & quick entry (`src/telegram/`, spec `docs/TZ-telegram-quick-entry.md`)
Webhook → dedupe in `telegram_updates` → 200 immediately → async processing with lease; recovery every 30 s, abandon after 10 attempts.
Commands `/start`, `/help`, `/language` (`/lang`, `/til`), `/cancel`, `/stop`, hidden owner-only `/idea`.
Text → quotas (10/min, 20/day free, 100/day Premium) → **LLM parse** (`TELEGRAM_PARSE_MODEL` default `gpt-5.4-mini`, escalation `gpt-5.6-terra` on low confidence; items transaction/transfer/debt/debt_payment, ≤10)
→ deterministic resolvers (amount k/m, date Asia/Tashkent, category, card) → save immediately via idempotent `create*Once` (marker in `telegram_operations`) or **draft** with reasons (`telegram_drafts`; drafts never affect balances). `FX_UNAVAILABLE` → `waiting_fx` retried up to 168 h.
Telegram tx get `origin:'telegram'` (never `source`). Callback data `v1:<action>:<item>:<option>` ≤64 bytes (indexes into `telegram_messages`).
Non-transaction text → stateless AI answer (counts AI quota). Premium media: voice (`gpt-4o-mini-transcribe`, ≤60 s), receipt photo (vision model). Per-user switch `profile.telegramQuickEntryEnabled`.

## Notifications (Telegram, dark launch / owner-only rollout)
Planner every 15 min: profiles with `notifications.nextDailyAt <= now` (or only `NOTIFY_ALLOWED_UIDS`), next 10:00 Tashkent slot, ≤1 daily digest/user/day (events: subscriptions due, debts due/overdue, credit due day, deposit end/interest, goals; lifecycle trial_ending, premium_expired, trial_available, no_cards; weekly Monday, monthly 1st, optional AI insight).
Budget checks debounced 5 min after money writes → `budget_80`/`budget_100` once per category/month.
Delivery every 5 s: lease, quiet hours 22–08, 1 msg/s/chat, global 25/s (per process), ≤6/user/day, 403/400 → blocked/unreachable, 429 respects retry_after, ≤8 attempts. Action buttons: pay subscription, settle debt, disable.
Defaults `enabled:true` (opt-out). User toggle only `PATCH /v1/profile/notifications`. Full rollout = backfill, clear `NOTIFY_ALLOWED_UIDS` in `.env` AND pm2 env, restart api + single worker. Enabling notifications needs owner confirmation.
Spec: `docs/TZ-notifications.md`.

## AI
Chat model `AI_MODEL_FREE` (`gpt-5.4-mini`) / `AI_MODEL_PREMIUM` (`gpt-5.6-terra`), `store:false`, uid-hash safety_identifier. Server builds financial snapshot (12 months) in `prompts/buildContext.ts`.
Quota reserved before call, refunded on failure/empty/truncated; token/cost metadata (no content) in `ai_usage`.

## Offline sync (additive, contract v1) — full contract: [docs/offline-sync.md](../offline-sync.md)
For the native app (SQLite + outbox). Branch `claude/api-offline-sync-f3399a`; needs **migration `003_offline_sync` applied by the owner before it is active** (code is safe without it: `isSyncEnabled()` false → no change index, no idempotency markers, `/v1/sync/changes` 503, everything else as before).
- **Choke point:** every document write goes through `SqlTransaction.flush` (`db/documents.ts`). It records one row per changed doc in `sync_entries` (upsert or tombstone, per-user scope `u:<uid>` from `data.userId`; profile/settings by doc id; household-owned rows excluded) and allocates `seq` from `sync_state` **last in the transaction** (counter row lock held to commit ⇒ seq follows commit order, no timestamp overlap windows). Do not write entity tables outside `documents.ts`. `updatedAt` is NOT relied on for sync.
- **Idempotency:** `middleware/idempotency.ts` (after `authenticate`) + AsyncLocalStorage context (`db/idempotencyContext.ts`). Only routes in the `HONOURED` allowlist (single-transaction mutations) honour the key, all others ignore it (`Idempotency-Ignored: true`) — add new single-tx mutations there. `runSqlTransaction` plain-INSERTs the marker (`idempotency_keys`, id sha256(`uid:key`)) before the first effect flush, so marker + effect commit atomically; a duplicate key (`ER_DUP_ENTRY`) aborts the transaction (`IdempotencyConflict`) and the error handler replays the stored response. Final 2xx response is stored before it is sent (`res.json`/`res.end` wrapper). Errors are never stored. Because services open their own transactions, **never run non-idempotent side effects before the effect transaction inside a mutating handler**.
- **Client ids:** optional `id` on create schemas (`domain/clientId.ts`); create-or-get inside the same tx; PATCH/household schemas must not accept `id`.
- Endpoints: `GET /v1/sync/capabilities`, `GET /v1/sync/changes?cursor&limit`. Maintenance (`db/syncMaintenance.ts`, in the API process): prune tombstones > 90 d (sets `floor_seq` ⇒ 410 `CURSOR_EXPIRED`) and expired idempotency markers.
- Env: `OFFLINE_SYNC_ENABLED` (kill switch), `SYNC_EPOCH`. Tests: `npm run test:mysql` (`tests/migration/offline-sync.integration.test.ts`), unit tests in `tests/sync`, `tests/clientId`.

## Other
- iPhone Shortcut: keys `pulim_sc_<base64url>`, sha256 stored; `scripts/build-shortcut.py` builds the file pointing at `https://api.m-pulim.uz/shortcut/v1`.
- Communications: campaigns ru/uz/en, channels in_app/telegram, presentation inbox/banner/modal, audience tier/lang/telegram-linked; draft→scheduled→sending→completed (+paused/failed); marketing prefs inApp:true, telegram:false.
- Dev notes: statuses new → in_progress → done|needs_reply|rejected; owner reply reopens. CLI `node dist/cli/devNotes.js pending|show|screenshot|claim|release|resolve|find-uid`. See [workflow](workflow.md).
- External: Telegram Bot API, OpenAI, Eskiz SMS (`notify.eskiz.uz`, texts must match approved templates in `phoneAuth.service.ts MESSAGE_TEMPLATES`), cbu.uz, Firebase Auth.

## Deploy / ops
Deploy `~/.claude/scripts/pulim-deploy.sh api` (ff-only pull, npm ci if lockfile changed, build, `pm2 restart pulim-api pulim-worker --update-env`). **Schema migrations are NOT automatic** (`npm run db:migrate:prod` with migrator DB user; runtime DB user has only DML).
Deploy health check curls `/` → 404 is normal; real readiness is `/health/ready`.
Backups: root cron daily 03:17 → `scripts/migration/backup-mysql.sh` for app DB and payment DB, into `/root/pulim-backups/mysql` (retention deletion off unless `PULIM_BACKUP_RETENTION_DAYS ≥ 30`). Cutover snapshots `/root/pulim-backups/firestore-mysql-20261013`.
Env names (groups): server (NODE_ENV, PORT, BIND_HOST, LOG_LEVEL, CORS_ORIGINS, MAINTENANCE_MODE, BACKGROUND_JOBS_ENABLED), MYSQL_* (read in db/database.ts), FIREBASE_* / GOOGLE_APPLICATION_CREDENTIALS,
TELEGRAM_* (BOT_TOKEN, WEBHOOK_SECRET, WEBHOOK_URL, BOT_USERNAME, QUICK_ENTRY_ENABLED, PARSE_*, VOICE/RECEIPT/TRANSCRIBE models, FX_RETRY_*), WEB_APP_URL, PREMIUM_CHECKOUT_URL,
NOTIFICATIONS_ENABLED + NOTIFY_*, OPENAI_API_KEY + AI_*, DEV_NOTES_UIDS, PULIM_PAYMENT_INTERNAL_SECRET, ESKIZ_*, PHONE_CODE_*, PHONE_AUTH_DEBUG_ECHO_CODE (rejected in prod).
`.env.example` misses BIND_HOST, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, TELEGRAM_TRANSCRIBE_MODEL, TELEGRAM_VOICE_MAX_SECONDS, TELEGRAM_RECEIPT_MODEL.

## Tests & conventions
Vitest ~144 cases/33 files (mostly pure logic / mocks — don't prove SQL atomicity); real MySQL integration in `tests/migration/*.integration.test.ts`.
zod for all inputs; `AppError` UPPER_SNAKE codes; `asyncHandler`; pino dotted event names; domain logic ported verbatim from the frontend — keep UI and API in sync.
User-facing bot/notification/SMS texts localized uz/ru/en, default `uz`.

## Gotchas / known issues (2026-10-21)
- `PATCH /v1/cards/:id` accepts `cardType` and `balance` without free-plan checks (free user can switch debit→credit or overwrite balance); `enforceLimit` counts only personal cards; household budgets/goals not Premium-gated.
- Telegram initData verification has **no `auth_date` freshness check**.
- Planner with `NOTIFY_ALLOWED_UIDS` reads `document.data.notifications` before checking `exists` → allowlisted uid without profile aborts the tick.
- No pagination anywhere; `userScopedRepo` sorts in memory.
- No TTL cleanup for drafts, markers, notifications, phone codes, invites.
- Firestore leftovers: `firebase.json`, `firestore.indexes.json`, firestore dep, `uid` duplicate in telegram_users, stale comments/docs.
- README omits many endpoints and points to a non-existent CLI header comment.
- **Secrets:** local secret files (`.env*`, `serviceAccountKey.json`, `oldServiceAccountKey.json`, `.migration-artifacts/` with real data snapshots) are gitignored and must never be printed or committed.
