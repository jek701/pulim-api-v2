# Offline sync contract (pulim-api-v2) — contract version 1

Status: **DRAFT, implementation in progress** on branch `claude/api-offline-sync-f3399a` (not deployed, not pushed).
Everything here is **additive**: a client that sends no `Idempotency-Key` and no `id` behaves exactly as before.
Consumer: the native Expo app (`rn-offline-core`): local SQLite + outbox, replay later, several devices.

## 0. Capability detection

`GET /v1/sync/capabilities` (auth required)

```json
{
  "contract": 1,
  "offlineSync": true,
  "idempotency": { "header": "Idempotency-Key", "keyPattern": "^[A-Za-z0-9_-]{16,128}$", "ttlDays": 30 },
  "clientIds": { "pattern": "^[A-Za-z0-9_-]{8,64}$", "collections": ["transactions", "cards", "categories", "subcategories", "savingsGoals", "debts", "deposits", "subscriptions", "plannedExpenses"] },
  "changes": { "defaultLimit": 200, "maxLimit": 500, "collections": ["profile", "settings", "categories", "subcategories", "cards", "transactions", "budgets", "savingsGoals", "debts", "deposits", "subscriptions", "plannedExpenses"] },
  "serverTime": 1790000000000
}
```

- A server without this feature returns 404 for this route → the app must stay online-only.
- `offlineSync: false` = code is deployed but the DB migration `003_offline_sync` is not applied yet; `/v1/sync/changes` answers `503 SYNC_UNAVAILABLE`. Idempotency-Key is then ignored (not stored).

## 1. Client-generated ids

Accepted as an optional `id` in the JSON body of:

| Endpoint | Creates |
|---|---|
| `POST /v1/transactions` | transaction |
| `POST /v1/transactions/transfer` | transfer transaction |
| `POST /v1/transactions/:id/return` | refund transaction (`id` = id of the refund) |
| `POST /v1/cards/refill` | refill (transfer) transaction |
| `POST /v1/cards` | card |
| `POST /v1/categories`, `POST /v1/subcategories` | category / subcategory |
| `POST /v1/savings-goals` | goal |
| `POST /v1/debts` | debt (initial cash tx: see §1b) |
| `POST /v1/deposits` | deposit |
| `POST /v1/subscriptions` | subscription |
| `POST /v1/planned-expenses` | planned expense |

### 1b. Operation endpoints: `transactionId`

Operation endpoints that create a transaction of their own accept an optional client **`transactionId`** (same format and rules as `id`) so the local row and the server row are the same row (no duplicate on the first pull):

| Endpoint | Body field | Notes |
|---|---|---|
| `POST /v1/debts` | `id` (debt) + `transactionId` (initial cash tx, only used when `accountId` is given) | both ids come from the client |
| `POST /v1/debts/:id/pay` | `transactionId` | |
| `POST /v1/subscriptions/:id/pay` | `transactionId` | |
| `POST /v1/savings-goals/:id/contribute` | `transactionId` | |
| `POST /v1/deposits/:id/collect-interest` | `transactionId` (body optional otherwise) | |
| `POST /v1/deposits/:id/close`, `/replenish`, `/withdraw` | `transactionId` | |

Semantics: if an own transaction with that id and the same kind (`source`) already exists, the operation counts as already applied: **no writes, no second balance effect**, and a best-effort response of the usual shape is returned (`Idempotency-Key` replays are exact). An id owned by someone else or created by a different kind of operation → `409 ID_CONFLICT`. Server-made transactions without `transactionId` keep a server id (old clients).

### 1c. Operation time: `date`

Optional `date` (epoch ms, the moment the user acted) is accepted on `POST /transactions/transfer`, `/cards/refill`, `/subscriptions/:id/pay`, `/debts` (initial cash tx), `/debts/:id/pay`, `/savings-goals/:id/contribute`, `/deposits/:id/(collect-interest|close|replenish|withdraw)`; `POST /transactions/:id/return` already had `date`, and `POST /transactions` has always taken it. It becomes the transaction `date` and `createdAt` (for deposits also the `now` of the interest/principal computation, `closedAt`, tranche date). The server accepts it only within **[serverNow − 90 days, serverNow + 5 minutes]**; outside that window, or when absent, it silently uses its own now (today's behaviour).

### 1d. Category edits

`PATCH /v1/categories/:id` (`name`, `icon`, `color`; `type` is immutable and ignored) and `PATCH /v1/subcategories/:id` (`name`; `categoryId` immutable). Owner only (403 otherwise, 404 missing). Built-in categories (`${uid}__default__…`) are editable on the free plan; custom categories need Premium (`403 PREMIUM_REQUIRED`). Both honour `Idempotency-Key` and appear in the delta feed.

Rules
- Format `^[A-Za-z0-9_-]{8,64}$`. Use UUIDv4 (36 chars) or ULID (26). Rejected with `400 VALIDATION_ERROR`:
  exactly 20 alphanumerics (reserved for server ids), any id containing `__` (default categories `${uid}__default__…`, `__income__` style specials), ids starting with `telegram_`.
- Create with an id that **already exists and belongs to the same user** → the existing document is returned (status 201, same shape), **no second write, no second balance effect**. The payload is *not* compared (stored doc wins); use `Idempotency-Key` for strict mismatch detection.
- Id exists but belongs to someone else (or to a household) → `409 ID_CONFLICT` (no information about the owner).
- Free-plan **count limits** (`LIMIT_REACHED` for cards/subscriptions) are skipped for a replayed create of an existing own document, but still apply to a real first create. **Premium-only creates** (custom categories, goals, debts, deposits, planned expenses) re-check Premium on every request without an `Idempotency-Key`: if Premium lapsed between the original create and a replay that lost its response, the replay gets `403 PREMIUM_REQUIRED`. Always send `Idempotency-Key` too — its replay is answered before any gate. `403 LIMIT_REACHED` / `PREMIUM_REQUIRED` on a first create are terminal for that op (drop it and tell the user).
- Without `id` the server generates one as before.
- Documents never contain an `id` field in storage; responses are `{ id, ...fields }` as always.

## 2. `Idempotency-Key`

Send `Idempotency-Key: <uuid>` (pattern `^[A-Za-z0-9_-]{16,128}$`) on the outbox mutations below; one key per outbox operation, reused verbatim on each retry.

**Honoured (each is exactly ONE SQL transaction on the server):**
`POST /transactions`, `/transactions/transfer`, `/transactions/:id/return`, `PATCH /transactions/:id`, `/transactions/:id/transfer`, `/transactions/:id/return`, `DELETE /transactions/:id`; `POST /cards`, `/cards/refill`, `PATCH|DELETE /cards/:id`; `POST /categories|/subcategories|/savings-goals|/debts|/deposits|/subscriptions|/planned-expenses`; `PATCH /categories|/subcategories|/savings-goals|/debts|/subscriptions|/planned-expenses/:id`; `DELETE` of any of those collections; `POST /savings-goals/:id/contribute`, `/debts/:id/pay`, `/subscriptions/:id/pay`, `/deposits/:id/(collect-interest|close|replenish|withdraw)`; `PUT|DELETE /budgets/:categoryId`; `PATCH /settings`.

**Ignored (header has no effect, response carries `Idempotency-Ignored: true`):** everything else — `PATCH /profile` and other profile routes, `DELETE /transactions` (clear all), households, AI, dev notes, communications. Those are multi-step on the server; retry them as naturally idempotent set-style operations (replaying `PATCH /profile` with the same fields is harmless).

- Server stores `(uid, key) → status + body` for 30 days. A replay returns the **original status and body** with header `Idempotent-Replayed: true` and has **no new effect**.
- Reusing a key with a different method/URL/body → `422 IDEMPOTENCY_KEY_REUSED`. Invalid key format → `400 INVALID_IDEMPOTENCY_KEY`.
- Only successful (2xx) responses are stored. 4xx/5xx are not: the transaction rolled back, nothing was committed, a retry re-runs the request (it may legitimately succeed later, e.g. after the card it needs was created).
- Atomicity: the key marker is inserted in the **same SQL transaction** as the effect, so a stored marker always means a complete effect. Two concurrent requests with the same key: exactly one effect, the other replays.
- Rare crash window: the effect committed but the server died before storing the final response. The replay then answers with the success status of that endpoint and the transaction's result (empty body for PATCH/DELETE and plain CRUD creates) plus header `Idempotent-Replay-Partial: true`. Treat it as success and rely on the next delta pull for the data.
- `DELETE` of a missing doc is `404` without a key. Treat `404` on DELETE as success in the app.

## 3. Delta sync: `GET /v1/sync/changes`

Query: `cursor` (opaque string, optional), `limit` (1..500, default 200 — counts documents upserted + deleted in the page).

```json
{
  "mode": "snapshot",
  "cursor": "<opaque>",
  "hasMore": true,
  "serverTime": 1790000000000,
  "collections": {
    "cards": { "upserted": [ { "id": "…", "name": "…", "balance": 1000 } ], "deleted": ["id1"] }
  }
}
```

- No `cursor` = start of a **full snapshot**, paged. `mode: "snapshot"` pages never contain `deleted`. When a snapshot finishes (`hasMore:false`) the returned `cursor` is a delta cursor. **Sweep rule:** after a completed snapshot delete local synced rows (without pending outbox ops) that the snapshot did not mention.
- With a delta cursor: `mode: "delta"`: documents created/changed since the cursor and ids deleted (tombstones, also for a document that moved to another owner (e.g. an own transaction turned into a family-space one), including cascades: refunds removed with their purchase, `clear data`, debt/deposit/goal deletions, household-driven deletions of own docs).
- `upserted` documents have exactly the shape of the corresponding `GET` endpoint (`{id, ...fields}`), `profile` = `GET /v1/profile`, `settings` = `GET /v1/settings` (only present once the user has a settings document).
- Persist `cursor` only after the page is applied locally. Apply upserts as idempotent full-row replace. The same document may appear again in a later page (idempotent). Repeat while `hasMore`.
- The feed contains exactly the documents the personal GET endpoints return for the user (docs whose `userId` is the caller; includes family-space transactions made from the user's own cards, with `scope:"household"`). **Household-owned data (shared cards, shared goals, budgets of the family space) is not in v1 of the feed** — keep using `/v1/households/*` online.
- `410 CURSOR_EXPIRED`: tombstones older than the retention window (90 days) were pruned → restart without a cursor. `400 INVALID_CURSOR` for a malformed cursor.
- Every write path is covered at the storage layer (one choke point), so Telegram quick entry, the iPhone Shortcut, notifications (profile `notifications.nextDailyAt`), billing webhook, balance bumps of transfers/returns/pay/contribute etc. all produce changes. Because the profile document changes on server-side jobs, expect it to show up occasionally even when the user did nothing.

### Cursor semantics (why it is safe)
Per user there is a server-assigned, gapless-per-commit **sequence** (`sync_state.seq`). A writing transaction takes the row lock of that counter at the very end of its flush and holds it until commit, so sequence numbers are assigned **in commit order**. A reader can therefore never see seq N+1 without N: no "skipped because a slower transaction committed later" hole, no clock/timestamp overlap window needed. Entries are one-per-document (upsert / tombstone), so the table stays small. Delta cursor = highest seq delivered. Snapshot cursor embeds the head seq taken *before* the first page; changes during snapshot paging are delivered by the first delta call (idempotent).

## 4. Errors / what the outbox should do

| Response | Meaning | Outbox |
|---|---|---|
| 2xx | applied (or replayed) | remove op |
| 400, 403, 404, 409 `ID_CONFLICT`, 422 | permanent | mark failed, surface to user (404 on DELETE = success) |
| 401 | token expired | refresh token, retry |
| 408/429/5xx/network | transient | retry with the same `Idempotency-Key` and same `id` |

Order matters: replay ops in creation order per user (create card → create tx on that card).

## 5. Server notes (for the owner / deploy)

- **Migration `003_offline_sync` (additive, never drops):** creates `sync_state`, `sync_entries`, and (through the generic document-table loop) `idempotency_keys`; records `003_offline_sync` in `schema_migrations`. Apply BEFORE deploying the new code, with the migrator DB user:
  `cd /root/pulim-api-v2 && git pull --ff-only && npm ci && npm run build && npm run db:migrate:prod` (old running code is unaffected by the new tables), then `pm2 restart pulim-api pulim-worker --update-env`.
- Safe order of operations: code deployed without the migration = feature off (`offlineSync:false`), web app unaffected. Migration without the new code = harmless.
- After the migration is applied the processes must be **restarted** once (they detect `003_offline_sync` at boot).
- Kill switch: `OFFLINE_SYNC_ENABLED=false` in the server `.env` + restart. If sync was off for a period after clients already synced, set `SYNC_EPOCH=<n+1>` so all old cursors answer 410 and clients resnapshot.
- Retention: tombstones 90 days, idempotency markers 30 days; pruned by `db/syncMaintenance.ts` in the API process (first run 5 min after boot, then every 6 h).
- Cost: every write transaction that touches user documents adds one counter upsert and one index upsert per changed document (inside the same transaction).

## 6. Running the API locally for client development

Real Firebase auth cannot be used locally, so there is a **local-only** dev server with the real routers/services and a fake auth header:

```bash
docker compose -f compose.migration.yaml up -d      # MySQL 8.4 on 127.0.0.1:3308 (rehearsal DB only)
cp <path>/.env.mysql-test .env.mysql-test            # local rehearsal DB creds (gitignored; ask the owner's checkout)
npm run dev:offline-sync                             # http://127.0.0.1:3112/v1 , runs migrations incl. 003 on the rehearsal DB
```

Send `x-test-uid: <any string>` instead of `Authorization`. Supported: profile (incl. `POST /v1/profile/bootstrap` for default categories), settings, categories, subcategories, cards, budgets, savings goals, subscriptions, planned expenses, transactions, debts, deposits, `/v1/sync/*`. The script refuses to start unless `MYSQL_HOST=127.0.0.1`, `MYSQL_PORT=3308`, `MYSQL_DATABASE=pulim_app_rehearsal`. Premium-gated creates need Premium: `POST http://127.0.0.1:3112/dev/grant-premium` with the same `x-test-uid` header (local helper, 30 days).
