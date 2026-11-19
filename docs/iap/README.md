# Pulim Premium via Apple In-App Purchase — brief (2026-11-19)

Why: App Review rejected build 27 under 3.1.1 (Premium sold through ATMOS in the iOS app). Decision: on iOS, Premium is sold ONLY via Apple In-App Purchase (auto-renewable subscriptions). Web and the Telegram Mini App keep ATMOS unchanged. Premium bought on web/Telegram still unlocks the iOS app (3.1.3(b)), with no mention of it in the iOS app.

The full design was written on 2026-11-03 and still holds: **read `docs/iap/original-brief-2026-11-03.md` first** (Parts A, B, C). This file lists only what changed since then and how the work is split now. Where they disagree, THIS file wins.

## Repos, worktrees, branches (all `claude/iap`)
- payment: `/Users/macbookair/WebstormProjects/pulim-payment-api/.claude/worktrees/iap` (base e92459d = prod)
- api: `/Users/macbookair/WebstormProjects/pulim-api-v2/.claude/worktrees/iap` (base b0cf8b8 = prod)
- app: `/Users/macbookair/WebstormProjects/pulim-react-native/pulim/.claude/worktrees/iap` (base `claude/release-1.0`)

## Common rules
- Do NOT commit, push, deploy, or run migrations against any real database. The lead reviews and commits.
- Never read/print/commit secrets (`.env*`, `.p8`, service-account JSON). New secrets = env vars with placeholder names in `.env.example` + docs.
- Existing ATMOS / web / Telegram behaviour must stay byte-for-byte the same; existing tests stay green.
- Read each repo's `AGENTS.md` and `docs/ai/*`. Expo SDK 58: check APIs against https://docs.expo.dev/versions/v58.0.0/ and the expo-iap docs, not memory.

## Facts (verified 2026-11-19)
- Bundle id `com.izik.pulim` (production; `app.json`), App Apple ID `6828525888`.
- Product IDs / plan codes / periods: exactly the table in the original brief (`com.izik.pulim.premium.1m|3m|6m|12m`). One group "Pulim Premium". 7-day free introductory offer on each.
- `expo-iap` latest is 6.5.1; `@apple/app-store-server-library` latest is 3.1.0; payment server runs Node 24.
- Prod already blocks ATMOS for the native iOS app (`pulim-payment-api` `src/domain/ios-app.ts`: empty `/v1/plans`, 403 on `/v1/checkout-sessions` for UA `…CFNetwork/… Darwin/…`). KEEP that block. The iOS app gets its catalog from `/v1/apple/config` + StoreKit, never from `/v1/plans`.
- `/v1/account/delete` now schedules deletion (30-day window, `deletionRequestedAt`); the purge erases data later. Apple subscriptions are NOT cancelled by us — deletion text must tell the user to cancel the subscription in Apple settings.

## Part A — pulim-payment-api (Codex, Sol high)
Implement original Part A with these changes:
1. Migration number is **`004_apple_subscriptions`** (the owner has an uncommitted `003_saved_cards` in the main checkout — do not use 003, and make 004 independent of 003).
2. The native-iOS ATMOS block stays; new `/v1/apple/*` routes are NOT blocked for iOS.
3. Account deletion: when pulim-api-v2 purges an account it already fans out; add nothing that would re-grant entitlements to a purged user (notification for an unknown/deleted user → store event, no grant).
4. Write `docs/apple-iap.md` (owner setup steps, see Part D below) and `.env.example`.
Checks: `npm run typecheck`, `npm run lint` (if present), `npx vitest run` (tests needing real env vars may fail on untouched main too — list them), `npm run build`.

## Part B — pulim-api-v2 (Codex, Terra medium)
Implement original Part B unchanged, plus:
- Scheduled-deletion accounts (`deletionRequestedAt`) keep ignoring billing events exactly as today (`billingInternal.routes.ts:48`).
Checks: `npm run typecheck && npm run lint && npx vitest run tests/<billing/profile/trial tests>` + `npm run build`.

## Part C — app (Codex, Sol medium)
A first version of Part C exists on branch `claude/apple-subscriptions` (commits 41f83fc..d4e1a37, based on a 184-commits-older main). Port it onto `claude/iap` (cherry-pick or re-apply by hand; resolve conflicts in favour of the CURRENT code structure), then adapt:
1. `src/lib/payments/availability.ts` (`PURCHASE_AVAILABLE`, from release 1.0) stays: ATMOS purchase UI is never shown on iOS. On iOS, `src/app/premium.tsx` renders the Apple paywall (`apple-premium-screen`) instead of the current trial-only screen; fall back to the trial-only screen (`trial-premium-screen.tsx`) when `/v1/apple/config` says disabled or StoreKit products fail to load. Android/web unchanged.
2. Server "7 days without a card" trial is hidden on iOS when the Apple paywall is available (Apple intro offer replaces it); it stays as the fallback screen otherwise.
3. CRM/push purchase links on iOS keep opening `/premium` (already done in release 1.0).
4. Account deletion confirmation (`src/i18n/account-release.ts`, ru/uz/en): if the profile subscription `source === 'apple'` and active, add a line: ru «Подписка Apple не отменяется автоматически — отмените её в настройках App Store.», en «Your Apple subscription is not cancelled automatically — cancel it in App Store settings.», uz «Apple obunasi avtomatik bekor qilinmaydi — uni App Store sozlamalarida bekor qiling.» plus a «Управлять подпиской» action opening the manage-subscriptions sheet.
5. Required paywall items (App Review 3.1.2): price per period, auto-renewal terms, trial terms, «Восстановить покупки», links to Terms of Use (use Apple standard EULA `https://www.apple.com/legal/internet-services/itunes/dev/stdeula/` unless `https://m-pulim.uz/legal/terms-<lang>.html` is used — use ours) and Privacy (`https://m-pulim.uz/legal/privacy-<lang>.html`).
6. Payment API base URL is `EXPO_PUBLIC_PAYMENT_API_BASE_URL` (already set in EAS production).
7. Keep the local StoreKit config (`scripts/storekit/Pulim.storekit`) for simulator runs.
Checks: `npx tsc --noEmit`, `npx expo lint`, full vitest run. Do NOT run `eas build`.

## Part D — owner steps (not code; listed in `docs/apple-iap.md`)
App Store Connect: Paid Apps agreement + bank + tax active; subscription group + 4 products with prices, ru/uz/en names, review screenshot, 7-day free intro offer; In-App Purchase key (.p8) → file on the server + env vars set by the owner; App Store Server Notifications V2 URL for Production and Sandbox `https://payment.m-pulim.uz/v1/apple/notifications` (verify the real payment host); run migration 004 on prod by hand; enrol in the Small Business Program; submit the 4 subscriptions together with the next app version.

## Report
Each part writes `docs/iap/report-<A|B|C>.md` in its own worktree: files changed, checks run with results, what is NOT verified, open questions.
