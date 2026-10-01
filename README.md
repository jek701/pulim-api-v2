# pulim-api

REST API for the Pulim budget tracker. Owns all data operations and business logic
that the React frontend previously did directly against Firestore, with server-side
integrity (atomic money operations), entitlement enforcement, and a server-side OpenAI key.

- **Runtime:** Node.js + TypeScript + Express 5
- **Datastore:** Firestore via `firebase-admin` (same project & collections as the app)
- **Auth:** Firebase Auth — the API verifies Firebase **ID tokens**; Telegram login mints a custom token
- **AI:** OpenAI Responses API (`openai`), server-side only, SSE streaming

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev            # tsx watch on http://localhost:3000
```

Scripts: `dev` (watch), `build` (tsc → dist), `start` (run API), `worker`
(run the notification worker), `dev:worker`, `backfill:notifications`, `typecheck`,
`lint`, `format`.

### Environment

See [.env.example](.env.example). Key vars: `FIREBASE_PROJECT_ID` + one credential
source (`FIREBASE_SERVICE_ACCOUNT_PATH` *or* `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`),
`TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY` (AI endpoints return `503` until set),
`CORS_ORIGINS` (comma-separated allowlist). Leave `FIRESTORE_DATABASE_ID` empty for
the default Firestore database `(default)`, or set it if your Firebase project uses
a named Firestore database.

## Architecture

Layered: **routes → controllers → services → repositories**. Only repositories/services
touch Firestore; controllers stay thin. Cross-cutting concerns live in `middleware/`,
the domain model + zod schemas + ported business logic in `domain/`.

```
src/
  config/      env (zod-validated), firebase (admin singleton)
  middleware/  authenticate, requirePremium, enforceLimit, validate, rateLimit, errorHandler, ...
  routes/      one router per resource + telegramAuth + ai + index (mounts /v1)
  controllers/ thin request handlers; crud.ts is a generic factory
  services/    business logic + atomic Firestore transactions
  repositories/ base (generic userId-scoped CRUD) + firestore helpers
  domain/      types, schemas (zod), entitlements, balance/deposit/debt/billing math, recurrence
  prompts/     chat system prompt + financial-context builder
  notifications/ durable queue, planner, delivery, collectors, rendering, schedule
```

Auth: every `/v1/*` route runs `authenticate` (verifies the Bearer ID token →
`req.uid`, `req.claims`). `POST /auth/telegram`, `POST /auth/phone/*` and
`GET /health` are public. Ownership is enforced in repositories
(`userId === req.uid`).

Errors use a consistent envelope: `{ "error": { "code", "message", "details?" } }`.

## Endpoints

Public: `GET /health`, `POST /auth/telegram` (Mini App sign-in / link; body
`{ telegramInitData, chatId, firebaseIdToken? }`), plus phone sign-in:

| Route | Body | Returns |
|---|---|---|
| `POST /auth/phone/send-code` | `{ phone, purpose?: 'signin'\|'link', language?: 'uz'\|'ru'\|'en', firebaseIdToken? }` | `{ expiresIn, resendAfter, requestId }` |
| `POST /auth/phone/verify` | `{ phone, code, purpose?, firebaseIdToken? }` | `{ uid, isNewUser, customToken }` (`signin`) / `{ linked: true }` (`link`) |

See [Phone sign-in over Eskiz](#phone-sign-in-over-eskiz) below.

All below require `Authorization: Bearer <firebaseIdToken>` and are under `/v1`:

| Resource | Routes |
|---|---|
| profile | `POST /profile/bootstrap`, `GET/PATCH /profile`, `PATCH /profile/home-widgets`, `PATCH /profile/notifications`, `POST /profile/telegram-link-dismissed` |
| settings | `GET/PATCH /settings` |
| categories | `GET /categories`, `POST` (premium), `DELETE /:id` |
| subcategories | `GET`, `POST`, `DELETE /:id` |
| cards | `GET`, `POST` (limit 1 / debit-only free), `PATCH/DELETE /:id`, `POST /cards/refill` |
| budgets | `GET`, `PUT /:categoryId` (premium), `DELETE /:categoryId` |
| savings-goals | `GET`, `POST` (premium), `DELETE /:id`, `POST /:id/contribute` |
| subscriptions | `GET`, `POST` (limit 2 free), `PATCH/DELETE /:id`, `POST /:id/pay` |
| planned-expenses | `GET`, `POST` (premium), `PATCH/DELETE /:id` |
| transactions | `GET`, `POST`, `PATCH/DELETE /:id`, `POST /transfer`, `PATCH /:id/transfer`, `POST /:id/return`, `PATCH /:id/return` |
| debts | `GET`, `POST` (premium), `PATCH/DELETE /:id`, `POST /:id/pay` |
| deposits | `GET`, `POST` (premium), `DELETE /:id`, `POST /:id/{collect-interest,close,replenish,withdraw}` |
| ai-chats | `GET`, `PATCH /:id` (rename), `DELETE /:id` |
| ai | `POST /ai/forecast`, `POST /ai/chat` (SSE), `POST /ai/feedback` |

### Atomicity

Money operations (transaction±balance, transfer, return, refill, debt create/pay,
deposit collect/close/replenish/withdraw, subscription pay, savings contribute) run in
`db.runTransaction()` so the transaction document and the affected card balance commit
together — a failure leaves nothing partially written.

### Entitlements

`profile.isPremium` is authoritative. Bootstrap never activates Premium. An eligible
user explicitly starts the one-time 7-day trial through
`POST /v1/profile/trial/start`; the server decides eligibility atomically. Existing
rollout trials keep their original expiry and can never be re-granted. Free limits:
1 debit card, 2 subscriptions, 1 AI chat, 10 AI messages / 30-day window;
premium-only features (custom categories, budgets, new debts, deposits, savings,
planned expenses) are gated server-side at mutation time.

### AI

`/ai/chat` streams Server-Sent Events (`meta`, `delta`, `done`, `error`). The financial
context is assembled and aggregated server-side from the user's own data (never trusted
from the client); model defaults to `gpt-5.6-terra` (premium) or `gpt-5.4-mini` (free).
Responses are not stored by OpenAI (`store: false`); usage is metered transactionally
and token/cost metadata is written to `aiUsage` without prompt or response content.
Output budgets are configurable with `AI_MAX_OUTPUT_TOKENS_FREE`,
`AI_MAX_OUTPUT_TOKENS_PREMIUM`, and `AI_MAX_OUTPUT_TOKENS_FORECAST`; these limits include
hidden reasoning tokens. Incomplete responses record their reason, preserve useful
partial text, and are refunded from the user's quota.

### Telegram bot and quick entry

`POST /telegram/webhook` accepts private Bot API updates after validating
`X-Telegram-Bot-Api-Secret-Token`. For an unlinked user, `/start` first asks for a
language; after the choice it shows the localized product welcome and offers a
one-step Telegram sign-in plus a separate existing-account linking path. The chosen
language is carried through authentication and stored in the profile. Free users
can record expenses, income, transfers, and repayments, and can use the shared free
AI allowance. Creating a new debt or custom category remains Premium-only.

Bot parsing has a separate 10/minute quota and configurable daily quotas: 20 for free
users and 100 for Premium by default (`TELEGRAM_PARSE_DAILY_LIMIT_FREE` and
`TELEGRAM_PARSE_DAILY_LIMIT_PREMIUM`). Ordinary transactions are written with
`origin: "telegram"`; `source` is never set.

Ambiguous operations remain in `telegramDrafts` and therefore never affect balances
or statistics. Foreign-currency operations wait durably in `waiting_fx` when the NBU
API is unavailable; the background worker obtains the rate and atomically writes the
transaction and card balance later. Firestore TTL should be enabled for the
`expiresAt` field in `telegramUpdates`, `telegramOperations`, `telegramDrafts`,
`telegramMessages`, and `telegramSessions`.

Set the public endpoint in the API environment:

```env
TELEGRAM_WEBHOOK_URL=https://api.m-pulim.uz/telegram/webhook
```

When `TELEGRAM_QUICK_ENTRY_ENABLED=true`, the API registers this URL and the
configured secret with Telegram automatically after the HTTP server starts. Repeated
startup registration is safe and does not discard pending updates.

Telegram Stars are intentionally not enabled; Premium checkout continues through
ATMOS only.

### Proactive Telegram notifications

Notifications use a durable Firestore queue and a separate single-instance worker.
At 10:00 `Asia/Tashkent`, the planner builds at most one daily message per user from
lifecycle events, subscriptions, debts, credit cards, deposits, goals, and the weekly
or monthly report. Empty digests are not queued. Budget thresholds and trial-start
messages are event-driven; quiet hours are 22:00–08:00. `/stop`, the inline disable
button, and `PATCH /v1/profile/notifications` all stop delivery and cancel pending jobs.

The user-facing setting accepts only:

```http
PATCH /v1/profile/notifications
Content-Type: application/json

{ "enabled": true }
```

All Telegram reachability, schedule, and rate-safety fields remain server-owned.
Delivery handles Telegram `403`/`429`, exponential retry, stale jobs, per-job leases,
one-message-per-chat throttling, and a hard per-user daily reservation. Production
must run exactly one `pulim-worker`; job claims prevent duplicate delivery if an old
process overlaps during a restart, but the global 25 messages/second limiter is local
to that worker process.

#### First deployment / test Firebase

Keep `NOTIFICATIONS_ENABLED=false` during the first deployment.

1. Deploy the indexes in `firestore.indexes.json` to the selected Firebase project
   (the included `firebase.json` points to it) and wait until all indexes are ready.
2. In Firestore, enable TTL on `expiresAt` for `notifications` and
   `notificationTasks`. Existing Telegram TTL policies stay enabled.
3. Run `npm run backfill:notifications -- --reschedule` with credentials for that
   project. The script is idempotent and preserves disabled users.
4. Start the API and worker through `pm2 start ecosystem.config.cjs`.
5. Set `NOTIFICATIONS_ENABLED=true` in the environment shortly before the 10:00
   slot and restart both processes with their updated environment.

Use a separate Firebase project and the test bot for integration acceptance before
production. Verify one daily dedupe key, simultaneous lease claims, quiet-hour
deferral, `429 retry_after`, blocked/unreachable transitions, callback ownership,
and idempotent subscription/debt payments. Do not enable production delivery until
the queue and lease indexes report ready.

### Phone sign-in over Eskiz

Replaces Firebase phone auth (and with it reCAPTCHA): the API owns the whole code
lifecycle and Firebase Auth is only the session/uid store.

1. `send-code` issues a 6-digit code, stores **only** its HMAC in
   `phoneVerifications/{digits}` and sends the SMS through
   `POST notify.eskiz.uz/api/message/sms/send` (`services/eskiz.service.ts`, bearer
   token cached in memory, refreshed on 401).
2. `verify` compares hashes in constant time, burns the code in a transaction (no
   replay, no double session), then either mints a custom token for the uid that
   owns the number — `auth.getUserByPhoneNumber`, so pre-existing phone users keep
   their uid and data — or creates the Firebase user for a new number.
   `purpose: 'link'` instead attaches the number to the uid proven by
   `firebaseIdToken` and returns no token.

Because reCAPTCHA is gone, the limits are ours: per-IP `phoneAuthLimiter`
(20/min), per-number resend cooldown (`PHONE_CODE_RESEND_COOLDOWN_SECONDS`),
sends per hour (`PHONE_CODE_MAX_SENDS_PER_HOUR`) and wrong-code attempts
(`PHONE_CODE_MAX_ATTEMPTS`). Enable Firestore TTL on `expiresAt` in
`phoneVerifications`.

Only `+998` numbers are accepted (`/message/sms/send` is domestic; international
would need `send-global`). The SMS text must match a template approved in the
Eskiz cabinet — `MESSAGE_TEMPLATES` in `services/phoneAuth.service.ts` holds the
uz/ru/en variants, picked from the `language` the client sends. Custom-token
sessions carry no `phone_number` claim, so the verified number travels in our own
`phone` claim (`domain/authMetadata.ts` reads it).

For local work without SMS, set `PHONE_AUTH_DEBUG_ECHO_CODE=true` — the code comes
back in the response and nothing is sent (startup refuses this in production).

## Frontend integration notes

- Point `VITE_TELEGRAM_AUTH_API_URL` at `<host>/auth/telegram`.
- Phone sign-in needs no Firebase provider on the client: `POST /auth/phone/verify`
  returns a custom token for `signInWithCustomToken`.
- Never expose `OPENAI_API_KEY` in Vite; call `/v1/ai/*` through the API.
- Send `Authorization: Bearer ${await user.getIdToken()}` on every `/v1` request.
- Replace the multi-call money sequences (transfer/return/deposit/debt/subscription/
savings) with the single corresponding endpoint.
- Edit transfers and returns only through their dedicated endpoints. Generic
  `PATCH /transactions/:id` intentionally rejects source-backed operations so it
  cannot update one balance leg without the other or desynchronise `returnedAmount`.
- Call `POST /v1/profile/bootstrap` once after login for default categories and auth
  metadata. Trial activation is a separate explicit `POST /v1/profile/trial/start`.
- Once writes flow through the API, tighten `firestore.rules` to deny direct client writes.
