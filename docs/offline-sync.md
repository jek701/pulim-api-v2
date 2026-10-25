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
| `POST /v1/debts` | debt (its optional initial cash transaction gets a server id; you get it through sync) |
| `POST /v1/deposits` | deposit |
| `POST /v1/subscriptions` | subscription |
| `POST /v1/planned-expenses` | planned expense |

Rules
- Format `^[A-Za-z0-9_-]{8,64}$`. Use UUIDv4 (36 chars) or ULID (26). Rejected with `400 VALIDATION_ERROR`:
  exactly 20 alphanumerics (reserved for server ids), any id containing `__` (default categories `${uid}__default__…`, `__income__` style specials), ids starting with `telegram_`.
- Create with an id that **already exists and belongs to the same user** → the existing document is returned (status 201, same shape), **no second write, no second balance effect**. The payload is *not* compared (stored doc wins); use `Idempotency-Key` for strict mismatch detection.
- Id exists but belongs to someone else (or to a household) → `409 ID_CONFLICT` (no information about the owner).
- Free-plan limit / Premium gates are skipped for a replayed create of an existing own document, but still apply to a real first create (403 `LIMIT_REACHED` / `PREMIUM_REQUIRED` are terminal for that op — drop it and tell the user).
- Without `id` the server generates one as before.
- Documents never contain an `id` field in storage; responses are `{ id, ...fields }` as always.

## 2. `Idempotency-Key`

Send on **every** `/v1` POST/PATCH/PUT/DELETE the outbox replays: header `Idempotency-Key: <uuid>` (pattern `^[A-Za-z0-9_-]{16,128}$`). One key per outbox operation, reused verbatim on each retry. Ignored on GET and on `POST /v1/ai/chat` (SSE).

- Server stores `(uid, key) → status + body` for 30 days. A replay returns the **original status and body** with header `Idempotent-Replayed: true` and has **no new effect**.
- Reusing a key with a different method/URL/body → `422 IDEMPOTENCY_KEY_REUSED`.
- Invalid key format → `400 INVALID_IDEMPOTENCY_KEY`.
- Only successful (2xx) responses are stored. 4xx/5xx are not: they mean nothing was committed, and a retry re-runs the request (a later retry may legitimately succeed, e.g. after the card it needs was created).
- Atomicity: for every endpoint whose effect is a SQL transaction (all money operations and all CRUD) the key marker is committed **in the same transaction** as the effect, so there is no window where the effect exists without the marker. Two concurrent requests with the same key: exactly one effect, the other replays.
- Endpoints without an own transaction (read-style POSTs) store the response afterwards (best effort).
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
- With a delta cursor: `mode: "delta"`: documents created/changed since the cursor and ids deleted (tombstones, including cascades: refunds removed with their purchase, `clear data`, debt/deposit/goal deletions, household-driven deletions of own docs).
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

## 5. Deploy / migration notes

See "Migrations" at the end of this file (filled in at the end of the implementation).
