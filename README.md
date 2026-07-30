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

Scripts: `dev` (watch), `build` (tsc → dist), `start` (run dist), `typecheck`, `lint`, `format`.

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
```

Auth: every `/v1/*` route runs `authenticate` (verifies the Bearer ID token →
`req.uid`, `req.claims`). `POST /auth/telegram` and `GET /health` are public.
Ownership is enforced in repositories (`userId === req.uid`).

Errors use a consistent envelope: `{ "error": { "code", "message", "details?" } }`.

## Endpoints

Public: `GET /health`, `POST /auth/telegram` (Mini App sign-in / link; body
`{ telegramInitData, chatId, firebaseIdToken? }`).

All below require `Authorization: Bearer <firebaseIdToken>` and are under `/v1`:

| Resource | Routes |
|---|---|
| profile | `POST /profile/bootstrap`, `GET/PATCH /profile`, `PATCH /profile/home-widgets`, `POST /profile/telegram-link-dismissed` |
| settings | `GET/PATCH /settings` |
| categories | `GET /categories`, `POST` (premium), `DELETE /:id` |
| subcategories | `GET`, `POST`, `DELETE /:id` |
| cards | `GET`, `POST` (limit 1 / debit-only free), `PATCH/DELETE /:id`, `POST /cards/refill` |
| budgets | `GET`, `PUT /:categoryId` (premium), `DELETE /:categoryId` |
| savings-goals | `GET`, `POST` (premium), `DELETE /:id`, `POST /:id/contribute` |
| subscriptions | `GET`, `POST` (limit 2 free), `PATCH/DELETE /:id`, `POST /:id/pay` |
| planned-expenses | `GET`, `POST` (premium), `PATCH/DELETE /:id` |
| transactions | `GET`, `POST`, `PATCH/DELETE /:id`, `POST /transfer`, `POST /:id/return` |
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

`profile.isPremium` is authoritative. New users get a 30-day Premium trial on first
bootstrap. Free limits: 1 debit card, 2 subscriptions, 1 AI chat, 10 AI messages /
30-day window; premium-only features (custom categories, budgets, debts, deposits,
savings, planned expenses) are gated server-side at mutation time.

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

## Frontend integration notes

- Point `VITE_TELEGRAM_AUTH_API_URL` at `<host>/auth/telegram`.
- Never expose `OPENAI_API_KEY` in Vite; call `/v1/ai/*` through the API.
- Send `Authorization: Bearer ${await user.getIdToken()}` on every `/v1` request.
- Replace the multi-call money sequences (transfer/return/deposit/debt/subscription/
  savings) with the single corresponding endpoint.
- Call `POST /v1/profile/bootstrap` once after login instead of client-side trial /
  default-category / auth-metadata writes.
- Once writes flow through the API, tighten `firestore.rules` to deny direct client writes.
