# Native guest snapshot import

`POST /v1/profile/import-guest` uses the existing Firebase authentication middleware. Deploy this route before releasing a native build with guest account import. No database migration is required.

The request contains a UUID `importId`, `cards`, canonical guest default `categories`, `subcategories`, `transactions`, `subscriptions`, and optional `settings.cardOrder`. The initial guest contract accepts one debit card, two subscriptions, up to 1,000 transactions, and the existing 1 MiB HTTP body limit. The native client additionally caps its request at 512 KiB. Guest Premium entities and custom categories are not supported. Existing account free-plan limits are enforced atomically; a limit conflict preserves the guest snapshot and allows retry later.

The service validates and strips identity/sharing fields, forces the authenticated owner and personal scope, generates deterministic account-specific IDs, remaps references and retains existing account default category customizations. It inserts final account balances and transaction rows as a snapshot, without replaying balance effects. Existing account balances are not modified.

A permanent receipt in `idempotencyKeys` commits in the same SQL transaction as the imported rows. Repeating the same account/import ID and parsed payload returns the original receipt. Reusing that ID with another payload returns `409 GUEST_IMPORT_CONFLICT`. The response is `{ importId, imported: { cards, transactions, subscriptions }, idMap }`.

The native app journals the pending snapshot before sending it. It validates the full receipt, caches mapped rows and removes only unchanged captured guest records after server acknowledgement. Canonical guest categories remain available for a later guest session. Source data is retained on HTTP errors, missing receipts, account switches, unsupported data, or limit conflicts. Server acknowledgement remains authoritative if the following sync pull temporarily fails.

Validation: `tests/guestImport/guestImport.test.ts` covers final balances, refund references, ownership stripping, duplicate/concurrent requests, payload conflicts, free-plan limits, existing account values, special subscription categories, and category type validation. Native SQLite integration tests cover retry journals, incomplete receipts, account switches, concurrent calls and edits during import. All fixtures are synthetic; these checks do not exercise production data or Firebase sign-in UI.
