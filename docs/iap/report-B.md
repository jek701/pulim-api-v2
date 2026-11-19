# Part B — API report

## Changes

- `src/routes/billingInternal.routes.ts`: accepts Apple source, boolean trial and optional renewal, plan and environment fields; projects Apple trial and metadata to the profile; keeps Apple history even for an out-of-order event; clears Apple-only metadata when leaving Apple. Missing and scheduled-for-deletion accounts remain acknowledged without writes. ATMOS event projection remains unchanged.
- `src/domain/types.ts`, `src/domain/trial.ts`: add Apple profile fields and permanently block the server trial after Apple history, including after a later source change.
- `src/services/sync.service.ts`: advertises `appleSubscriptions`.
- `tests/account/billing.test.ts`, `tests/profile/trial.test.ts`, `tests/sync/syncIndex.test.ts`: cover Apple events, old events, deletion, trial history and capability.
- `docs/ai/api.md`: documents the billing and capability contract.

## Checks

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- Full suite: `WEB_APP_URL=https://example.test FIREBASE_PROJECT_ID=test-project TELEGRAM_BOT_TOKEN=test-token npx vitest run --configLoader runner` — 110 files passed, 3 skipped; 1,219 tests passed, 53 skipped. The final deletion test addition was subsequently verified in the focused run.
- Focused billing/profile/sync suite with the same environment and loader — 6 files and 50 tests passed.
- Plain `npm test` could not create Vite's temporary config in the shared read-only `node_modules`. The runner loader avoids that write. A first runner attempt with only `WEB_APP_URL` failed because the two required Firebase/Telegram environment values were absent; the successful run used synthetic values, not secrets.

## Not verified / open questions

- No real database, payment service, Apple sandbox, production deployment or end-to-end purchase was exercised. MySQL integration suites were skipped by their normal guards.
- The existing event contract still requires a UUID `orderId` and valid Premium `validFrom`/`validUntil`; Part A's Apple event producer must supply these existing fields. Confirm the cross-service payload during integration.
- No commits, pushes, deployments or migrations were made.
