# Pulim — product & system overview

**Pulim** is a mobile-first **personal and family finance tracker for Uzbekistan** (base currency UZS, languages **uz (default) / ru / en**).
Owner: Ikromjon (ikromjon.ahmadjonov@bellissimo.uz) — this is his own product, separate from BPI work. GitHub org/user `jek701`.
Users track income/expenses, accounts (debit/credit/cash), transfers, refunds, savings goals, debts, deposits, their own recurring subscriptions,
planned expenses/calendar, budgets, exchange rates, AI financial chat/forecast, a shared **family workspace** (2 members), a **Telegram bot** for quick entry
(text/voice/receipt parsed by LLM) and Telegram notifications. Monetisation: Free vs **Premium** (one-time 7-day trial, then paid periods via ATMOS, no auto-renew).

Snapshot: 2026-10-21. Deep references:
- [api.md](api.md) — backend, data model, endpoints, bot, notifications, AI
- [pulim-ui-v2 → docs/ai/ui.md](../../../pulim-ui-v2/docs/ai/ui.md) — web client / Telegram Mini App
- [pulim-payment-api → docs/ai/payments.md](../../../pulim-payment-api/docs/ai/payments.md) — billing service (ATMOS)
- [workflow](workflow.md) — how the owner works: dev notes, commits to main, deploy, safety rules

## Repos (all in `~/WebstormProjects/`)
| Repo | What | Stack | Prod |
|---|---|---|---|
| `pulim-ui-v2` | Web app = Telegram Mini App + PWA | React 19, Vite 8, TS, React Query, Firebase Auth, CSS Modules, i18next | `https://m-pulim.uz`, pm2 `pulim-ui-v2` :3000 |
| `pulim-api-v2` | Main REST API + Telegram bot webhook + worker | Express 5, MySQL (Kysely, JSON "document" tables), firebase-admin (auth only), OpenAI | `https://api.m-pulim.uz`, pm2 `pulim-api` :3111 + `pulim-worker` |
| `pulim-payment-api` | Billing: plans, orders, ATMOS invoices, entitlements | Fastify 5, MySQL (Kysely, relational), jose | `https://payment.m-pulim.uz`, pm2 `pulim-payment` :3100 + `pulim-payment-worker` |

## How they connect
```
UI (m-pulim.uz / Telegram Mini App)
  ├─ Firebase Auth (sign-in; ID token as Bearer everywhere)
  ├─ pulim-api-v2   /v1/*  (all business data, AI SSE, auth bootstrap: /auth/telegram, /auth/phone/*)
  └─ pulim-payment-api /v1/plans, /v1/checkout-sessions, /v1/orders/:id/refresh-status
          │  ATMOS hosted payment page (polling invoice/get, no webhooks)
          └─ outbox → POST api /internal/v1/billing/events (HMAC) → profile.isPremium/subscription
Telegram → POST api /telegram/webhook (bot: quick entry, /idea, family invites, notification buttons)
iPhone Shortcut → api /shortcut/v1/* (personal key)
External: OpenAI, Eskiz SMS, cbu.uz FX rates, Telegram Bot API, ATMOS
```
- One identity = **Firebase uid** across all services (Telegram-created users have uid `tg_<telegramId>`).
- Two separate MySQL DBs: `pulim_app` (main API, separate users for runtime DML vs migrator DDL) and `pulim_payments`. No cross-DB joins/writes; only the signed HTTP event.
- **Firestore is gone at runtime since 2026-10-13** (cutover). Old docs/comments/PROJECT_CONTEXT sections mentioning Firestore collections/rules are historical.

## Infrastructure
Single server, SSH alias **`myserver`** (root, key auth), Node 24.15 via nvm, MySQL 8.0, nginx for HTTPS, pm2 with 5 processes.
Paths `/root/pulim-ui-v2`, `/root/pulim-api-v2`, `/root/pulim-payment-api`. Secrets live only in server `.env` files.
Daily MySQL backup cron 03:17 → `/root/pulim-backups/mysql`. Deploy via `~/.claude/scripts/pulim-deploy.sh [ui] [api] [payment]` — migrations never automatic.

## Cross-repo invariants (never break)
1. Statistics must never break: transfers excluded from income/expense; returns reduce expense (not income); household-scope tx excluded from personal analytics.
2. Balance changes only via atomic server endpoints; one sign rule `balanceDelta` (credit card balance = debt). Balances stored, not recomputed.
3. Premium check = `isPremium && subscription.premiumUntil > now`; server authoritative. `profile.subscription` (Premium) ≠ `subscriptions` (user's bills).
4. Money amounts: main API stores plain numbers in account currency + optional `baseAmount` (UZS); payment API uses **tiyin** integers.
5. User-facing strings in all 3 locales (uz/ru/en). UI: `npm run check:i18n`.
6. Domain logic is duplicated UI↔API (ported verbatim) — change both sides together.
7. Payments, balances/transaction math, migrations, auth, prod env, enabling notifications, deleting user data = high risk → ask the owner first.
8. Never print secrets (`.env*`, service account JSONs, `.migration-artifacts/`) — BPI org policy too.

## Key dates
- 2026-06..08: payment API built (ATMOS polling design 2026-08).
- 2026-10-13: Firestore → MySQL production cutover (main API); UI stops using Firestore.
- 2026-10-14: notifications owner-only rollout support; RN port plan written.
- 2026-10-15..17: Mini App UI audits & "Apple UI" polish.
