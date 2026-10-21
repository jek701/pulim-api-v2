# AI agent guide — pulim-api-v2

This repo is part of **Pulim**, a personal and family finance tracker for Uzbekistan (Telegram Mini App + PWA).
Three repos work together: `pulim-ui-v2` (web client), `pulim-api-v2` (main API + Telegram bot), `pulim-payment-api` (billing via ATMOS).

Read before changing code:
1. [docs/ai/overview.md](docs/ai/overview.md): the product, how the repos connect, server and ports, rules that hold across repos
2. [docs/ai/api.md](docs/ai/api.md): deep reference: MySQL document store, endpoints, money rules, Telegram bot, notifications, AI, households, known issues
3. [docs/ai/workflow.md](docs/ai/workflow.md): commits, checks, deploy, what needs the owner's approval

The sibling repos have their own `docs/ai/` folders.
These docs are a snapshot from 2026-10-21. If a doc and the code disagree, trust the code and update the doc in the same change.

Essentials:
- Checks before declaring work done: `npm run typecheck && npm test && npm run build`
- Never print or commit secrets (`.env*`, service-account JSON files, real data exports).
- Ask the owner before touching balances or transaction math, payments, DB migrations, auth, production config, or deleting user data.
