# Task 1 brief: Apple auto-renewable subscriptions

Owner: Ikromjon. Lead/acceptor: Claude. Backend implementer: Codex. App UI implementer: Sonnet sub-agent.
Branch `claude/apple-subscriptions` in all three repos (worktrees `.claude/worktrees/apple-iap`):
- payment: `/Users/macbookair/WebstormProjects/pulim-payment-api/.claude/worktrees/apple-iap`
- api: `/Users/macbookair/WebstormProjects/pulim-api-v2/.claude/worktrees/apple-iap`
- app: `/Users/macbookair/WebstormProjects/pulim-react-native/pulim/.claude/worktrees/apple-iap`

Read first: each repo's `AGENTS.md` and `docs/ai/*` (payment: `docs/ai/payments.md`; api: `docs/ai/api.md`); app: `AGENTS.md`, `docs/offline-first.md`.

Rules:
- Commit on the branch only. Do NOT merge, push, deploy, or run migrations against any real database. No builds on devices.
- Never read, print, or commit secrets (`.env*`, `.p8` keys, service-account JSON). New secrets are env vars with placeholder names, documented in `.env.example` and docs.
- Follow each repo's style, naming, and comment density. Add tests. Keep changes additive: existing ATMOS/web/Telegram flows must behave exactly as today.
- Sub-agents allowed, but not the most expensive models.

## Owner decisions

- Four auto-renewable subscriptions in one group "Pulim Premium". Product IDs and plan codes:

| Product ID | Plan code | Period | Target price (UZS) |
|---|---|---|---|
| `com.izik.pulim.premium.1m` | `premium_1_month` | 1 month | 29 000 |
| `com.izik.pulim.premium.3m` | `premium_3_months` | 3 months | 79 000 |
| `com.izik.pulim.premium.6m` | `premium_6_months` | 6 months | 149 000 |
| `com.izik.pulim.premium.12m` | `premium_12_months` | 1 year | 249 000 |

- Apple introductory offer: 7-day free trial on every product (Apple decides eligibility, once per subscription group).
- On iOS the trial goes through Apple. Our server "7 days without a card" trial stays for web/Telegram and is hidden on iOS.
- No ATMOS links, buttons, or prices in the iOS app (App Review 3.1.1). Premium bought via ATMOS (web/Telegram) unlocks the iOS app (3.1.3(b)).
- Premium end = the latest of the ATMOS paid end and the Apple subscription end (including grace period).

## Part A — pulim-payment-api (Codex)

Billing truth lives here. Add Apple as a second provider without disturbing ATMOS.

1. **Dependencies.** Add `@apple/app-store-server-library` (official). Bundle Apple root certificates (Apple Root CA G3 and others needed by `SignedDataVerifier`) as files in the repo, downloaded from apple.com/certificateauthority. Check Node version compatibility with the library (the server runs Node 24).
2. **Env** (zod in `src/config/env.ts`, optional: when missing, the Apple feature is disabled and its routes answer `503 {error:{code:'apple_not_configured'}}`):
   - `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY_PATH` (path to the In-App Purchase `.p8` on the server);
   - `APPLE_BUNDLE_ID` (default `com.izik.pulim`), `APPLE_APP_APPLE_ID` (`6828525888`);
   - `APPLE_ALLOW_SANDBOX` (default true: TestFlight and App Review use the sandbox).
3. **Migration `003_apple_subscriptions`** (Kysely, additive). Write it and test it locally, never run it against prod.
   - `plans.apple_product_id` (nullable, unique). Seed the 4 mappings above.
   - `apple_account_tokens`: `user_id` PK, `app_account_token` UUID unique, `created_at`.
   - `apple_subscriptions`:
     - `original_transaction_id` unique, `user_id`, `product_id`, `plan_code`, `environment` (`Sandbox` | `Production`);
     - `status`: ACTIVE | GRACE | BILLING_RETRY | EXPIRED | REVOKED;
     - `auto_renew`, `is_trial` (intro offer active), `expires_at`, `grace_expires_at`;
     - `latest_transaction_id`, `last_synced_at`, timestamps.
   - `apple_transactions`: `transaction_id` unique, `original_transaction_id`, `product_id`, `purchase_at`, `expires_at`, `offer_type`, `revoked_at`, `environment`, sanitized decoded payload JSON.
   - Store notifications in the existing unused `provider_events` table: `provider='APPLE'`, `event_key` = `notificationUUID`, `signature_valid`, and the decoded type and subtype.
   - Widen enums or values: entitlement and grant `source` gains `APPLE`; `payments.provider` and `orders.client_channel` gain `ios` only if you actually use them.
4. **Entitlement reflow.** Implement one function that recomputes `entitlements` for a user from all sources:
   - `valid_until = max(active ATMOS grants end, Apple subscription end incl. grace)`;
   - `source` = whichever gives the latest end;
   - `version+1` only when something changed;
   - one outbox event per change.

   Keep ATMOS stacking exactly as today: an ATMOS grant stacks only on ATMOS `valid_until`, never on Apple. Refactor the ATMOS success and refund paths to call the reflow instead of writing entitlements directly, with no behavior change; the existing tests must stay green.
5. **Outbox event.** Same `billing.entitlement.updated` type with an incremented `version`. New optional fields: `source:'apple'`, `isTrial` (true while the Apple intro offer is active), `autoRenew`, `planCode`, `environment`. The ATMOS payload stays identical.
6. **Routes** (Firebase Bearer auth, same plugin as checkout; per-route rate limits):
   - `GET /v1/apple/config` (public): `{enabled, products:[{productId, planCode, months}]}`.
   - `GET /v1/apple/account-token`: returns the user's `appAccountToken`, creating it if missing.
   - `POST /v1/apple/transactions` with `{transactionIds: string[]}` (1–20):
     - For each id, call App Store Server API `getTransactionInfo`: Production first, then Sandbox on not-found, if allowed.
     - Verify the signed data with `SignedDataVerifier`. `bundleId` must match.
     - The `appAccountToken` must equal this user's token. If it is missing, link to this user unless the `originalTransactionId` is already linked to another user; then answer `409 apple_subscription_owned_by_other_account`.
     - Then call `getAllSubscriptionStatuses` for the original transaction and upsert `apple_subscriptions` and `apple_transactions`.
     - Then reflow, then deliver this user's outbox inline (like `refresh-status` does).
     - Response: `{entitlement:{tier, source, validUntil, isTrial, autoRenew, planCode}}`.
     - Used for purchase completion, restore, and renewals seen by the app. Must be idempotent.
   - `POST /v1/apple/notifications` (public, called by Apple; App Store Server Notifications V2):
     - Body `{signedPayload}`. Verify it with `SignedDataVerifier` for the payload's environment. Reject a wrong `bundleId` or app id.
     - Dedupe by `notificationUUID` in `provider_events`.
     - Re-fetch the authoritative status via `getAllSubscriptionStatuses`, upsert, reflow, and let the outbox deliver.
     - Answer 200 fast. Any internal failure answers 5xx so Apple retries.
     - Handle at least: SUBSCRIBED, DID_RENEW, DID_CHANGE_RENEWAL_STATUS, DID_CHANGE_RENEWAL_PREF, OFFER_REDEEMED, DID_FAIL_TO_RENEW (with or without GRACE_PERIOD), GRACE_PERIOD_EXPIRED, EXPIRED, REFUND, REFUND_REVERSED, REVOKE, TEST.
     - A notification for an unknown `originalTransactionId` that has an `appAccountToken` maps to the token's user. Without a token, store the event and do nothing else.
7. **Worker.** Add a reconciliation loop: Apple subscriptions whose `expires_at` (or `grace_expires_at`) has passed but are still ACTIVE/GRACE, plus a periodic daily re-check of all ACTIVE ones, are re-checked via `getAllSubscriptionStatuses`. Use a small batch with backoff.
8. **Tests.** Mock the Apple client and verifier. Cover:
   - token linking and the 409 case;
   - purchase → entitlement → outbox;
   - renewal extends;
   - grace keeps access;
   - expired, refund, and revoke remove access and fall back to an ATMOS end if one is later;
   - duplicate notification ignored;
   - ATMOS paths unchanged.
9. **Docs.** Update `docs/ai/payments.md`, `.env.example`, and README. Write `docs/apple-iap.md` with the setup steps: which App Store Connect key, which env vars, the notification URL `https://payment.m-pulim.uz/v1/apple/notifications` for both production and sandbox, and how to test in the sandbox.

## Part B — pulim-api-v2 (Codex)

1. `src/routes/billingInternal.routes.ts` event schema accepts:
   - `source: 'atmos' | 'apple' | 'none'`;
   - `isTrial: boolean`;
   - optional `autoRenew`, `planCode`, `environment`.

   Unknown extra fields are tolerated; the ATMOS behavior is unchanged.
2. Profile `subscription` gains:
   - `source: 'apple'`;
   - `autoRenew?: boolean`;
   - `planCode?: string`;
   - `isTrial` true for an Apple intro offer.
3. Update the domain types and the profile response.
4. In `src/domain/trial.ts`, the server trial is also blocked if the user has, or had, Apple Premium. That means any billing event with source `apple`, the same way ATMOS history blocks it.
5. Advertise `appleSubscriptions: true` in `syncCapabilities()`.
6. Add tests and update `docs/ai/api.md`.
7. Checks: `npm run typecheck && npm test && npm run build`. Tests need `WEB_APP_URL=https://example.test`.

## Part C — app (Sonnet sub-agent, design-heavy; lead reviews screenshots)

1. **Dependency.** Add `expo-iap`, using the version compatible with Expo SDK 58, with its config plugin. Check that it supports passing `appAccountToken` on iOS purchase; StoreKit 2 is required. If it does not, stop and report.
2. **Data layer** (`src/data/http` or a new `src/data/billing`): wire the payment-api calls `config`, `account-token`, and `transactions` with the existing auth/fetch helpers.
3. **App-level transaction observer.** Mounted once, signed-in users only.
   - On any purchase or renewal update, send the transaction ids to `POST /v1/apple/transactions`.
   - Call `finishTransaction` only after the server confirms. Unfinished transactions are retried on the next launch.
   - Then refresh the profile (react-query) so `useEntitlements` updates.
4. **`src/app/premium.tsx` on iOS** (keep web/ATMOS code paths untouched for other platforms; there are none today, so iOS is the main path):
   - **Products.**
     - Load products from StoreKit.
     - Show the 4 plans with the localized `displayPrice`. For 3, 6, and 12 months, also show the per-month equivalent and the saving versus monthly.
     - Preselect the year.
   - **Trial and the main button.**
     - Show "7 дней бесплатно" when StoreKit says the user is eligible for the intro offer.
     - The primary CTA reads "Попробовать бесплатно" when eligible, "Оформить" otherwise.
   - **Required subscription disclosure** under the CTA: price per period, auto-renewal, cancel anytime in Apple settings, and trial terms. Add links to Terms of Use (Apple standard EULA) and the Privacy Policy. Find the existing privacy URL used for App Store metadata; if none exists, report it.
   - **«Восстановить покупки»** syncs StoreKit, sends the current entitlements' transaction ids to the server, then shows the result.
   - **Active Apple subscription:** show the status, the renewal date or "не продлевается", and «Управлять подпиской». The button opens Apple's manage-subscriptions sheet, falling back to `https://apps.apple.com/account/subscriptions`.
   - **Active ATMOS Premium:** show "Premium активен до {date}" with no purchase CTA, to avoid a double purchase.
   - **Server trial:** hide the server "start trial" button on iOS.
   - **Guests:** the existing sign-in-required screen.
   - **Error states:** cancelled is silent; pending (Ask to Buy) and network failures have calm messages and retry; a 409 means the subscription is owned by another account.
   - **Feature flag:** if payment-api `/v1/apple/config` says disabled, or products fail to load, show the current "скоро" state. Never crash.
5. **Quality.** Mint design system, Liquid Glass where already used, haptics, dark and light, Dynamic Type, uz/ru/en for every string (default uz). Reuse the existing premium components (`premium-plans`, `premium-hero`, `premium-feature-list`).
6. **Tests** for the pure logic: the per-month and saving math, the CTA state machine, and the observer's finish-after-confirm rule (with mocks).
7. **Checks:** `npx tsc --noEmit`, `npx eslint src`, `npx vitest run`. Regenerate typed routes if you add routes.
8. **Screenshots.** Simulator screenshots go in `docs/next/screens/task1/`: dark and light, eligible-trial state, active Apple, active ATMOS, guest. StoreKit products may not load in the simulator without a StoreKit config file. Add a local `.storekit` configuration for simulator testing if feasible, and say what you could and could not run.

## Report

Write `docs/next/task1-report.md` in the app worktree:
- what changed in each repo and its commits;
- what was verified;
- what was NOT verified (real purchase needs TestFlight sandbox);
- the env vars and owner steps.
