# Task 4 API report: voice and receipt capture (Part A)

Branch `claude/capture`, worktree `.claude/worktrees/capture`. Nothing is pushed, merged, deployed or migrated. The feature is dark until the owner applies `005_capture` and sets `OPENAI_API_KEY`.

## Commits (oldest first)

Inherited from Codex (committed):
- `53bd511` Add safe Soliq receipt client and synthetic coverage
- `3d12d83` Parse capture amounts deterministically with multilingual evaluation
- `ce09ff2` Add capture storage and merchant category learning

Finished by Claude (Codex's uncommitted work, reviewed, fixed and split):
- `2e7e9ce` Add capture capability flags, env and shared helpers
- `3bcd126` Harden capture storage: virtual receipt-key projection, retrying readiness, AI suggestions
- `af7465e` Accept optional capture metadata on transaction create and learn after commit
- `16ec523` Add bounded, memory-only capture upload parsing and media validation
- `0f667d7` Add monthly capture quota with atomic reservation and refunds
- `c000c30` Add voice, Soliq and photo receipt capture endpoints
- `73e2e62` Send the weekly merchant review to the owner from the worker
- a final docs commit (this report and `docs/ai/api.md`)

## Migration `005_capture` (additive, not run anywhere)

Registered in `src/db/migrate.ts` (`migrateCapture`, which imports no env or dotenv; a test asserts it). Idempotent: `IF NOT EXISTS`, information_schema checks for the column and index, `INSERT IGNORE` seeds. Nothing is dropped or rewritten. Shared tables hold no raw uid; per-user tables (`merchant_user_category`, `capture_usage`) are the user's own data.

```sql
CREATE TABLE IF NOT EXISTS merchants ( tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, name VARCHAR(255) NULL, address VARCHAR(500) NULL, oked VARCHAR(32) NULL, seen_count BIGINT UNSIGNED NOT NULL DEFAULT 0, first_seen BIGINT NOT NULL, last_seen BIGINT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'unknown', standard_key VARCHAR(64) NULL ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS merchant_category_votes ( tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, standard_key VARCHAR(64) NOT NULL, weight_sum DECIMAL(14,2) NOT NULL DEFAULT 0, voter_count INT UNSIGNED NOT NULL DEFAULT 0, ai_weight DECIMAL(14,2) NOT NULL DEFAULT 0, PRIMARY KEY (tin, standard_key) ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS merchant_latest_votes ( tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, voter_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, standard_key VARCHAR(64) NOT NULL, weight DECIMAL(4,2) NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (tin, voter_hash) ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS merchant_user_category ( uid VARBINARY(512) NOT NULL, tin VARCHAR(14) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, category_id VARBINARY(2048) NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (uid, tin) ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ikpu_category_map ( prefix VARCHAR(17) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, standard_key VARCHAR(64) NULL, source VARCHAR(16) NOT NULL, updated_at BIGINT NOT NULL ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS capture_usage ( uid VARBINARY(512) NOT NULL, month CHAR(7) CHARACTER SET ascii NOT NULL, count INT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (uid, month) ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS capture_receipt_cache ( receipt_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, receipt_json JSON NOT NULL, expires_at BIGINT NOT NULL, INDEX capture_cache_expiry (expires_at) ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS capture_learning ( transaction_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, learned_at BIGINT NOT NULL ) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS capture_owner_summary ( week CHAR(10) CHARACTER SET ascii NOT NULL, owner_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, claimed_at BIGINT NOT NULL, PRIMARY KEY (week, owner_hash) ) ENGINE=InnoDB;

ALTER TABLE transactions ADD COLUMN capture_receipt_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS ( CASE WHEN JSON_TYPE(JSON_EXTRACT(data_json, '$.capture.receiptKey')) = 'STRING' THEN LEFT(JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.capture.receiptKey')), 64) ELSE NULL END ) VIRTUAL;

CREATE INDEX capture_owner_receipt ON transactions (user_id(512), capture_receipt_key);

-- plus 28 x INSERT IGNORE INTO ikpu_category_map (seed rows)
```

Rollout notes. `ADD COLUMN ... VIRTUAL` is an instant metadata change and `CREATE INDEX` is online (in place), so neither rebuilds nor blocks the `transactions` table; this is still unverified on real MySQL (see below). Rollback is `DROP INDEX capture_owner_receipt ON transactions; ALTER TABLE transactions DROP COLUMN capture_receipt_key;` plus dropping the nine new tables and deleting the `005_capture` row from `schema_migrations`.

## New env names

`CAPTURE_TRANSCRIBE_MODEL`, `CAPTURE_PARSE_MODEL`, `CAPTURE_RECEIPT_MODEL` (each defaults to the matching `TELEGRAM_*` model), `CAPTURE_COUNT_SOLIQ` (default false), `CAPTURE_VOTER_SALT` (at least 16 characters, without it nobody casts a shared vote), `SOLIQ_OFD_SIGNING_KEY` (never committed), `SOLIQ_AMOUNT_DIVISOR` (default 1). Placeholders are in `.env.example`.

## Parser accuracy on the evaluation set

`tests/capture/eval/phrases.json`: 146 synthetic phrases and 167 operations (ru 29, uz Latin 29, uz Cyrillic 29, en 29, mixed 30; 21 multi-operation). The parser alone, without any model:
- whole phrase (right number of amounts, in order, right value and currency): 146 / 146 = 100%;
- each operation's `amountSpan`: 167 / 167 = 100%;
- the same for every language: 100%.

This is a floor-check, not a forecast. The corpus was written together with the parser, so 100% overstates how it will do on real speech. The test requires at least 98%. Transcription errors and the model's choice of span are not covered. Model accuracy per field and language comes from `npm run capture:eval` (opt-in, needs `OPENAI_API_KEY`, makes real calls, I did not run it).

## What was reviewed and changed in Codex's uncommitted work

Kept as written: storage and learning logic, Soliq client, quota reservation, owner tooling, busboy upload approach, the rollout capability pattern.

Fixed or changed, and why:
- `upload.ts`: the 7-byte ADTS frame was rejected by an off-by-one length check (the one failing test in Codex's tree). busboy's `partsLimit` fires on reaching the limit, so a legitimate voice request with both optional fields was always rejected; the limit is now one above what is allowed. Added 2 s tolerance on the 60 s limit (the app timer overshoots), acceptance of `application/octet-stream` and `image/jpg` because the container is sniffed anyway, and provider file naming from the sniffed container instead of the client label.
- `schemas.ts`: capture metadata was `.strict()` with a uuid-only `draftId`, so any malformed field returned 400 and failed a money write (and an offline outbox item would fail permanently). It is now lenient: bad fields dropped, unknown keys (anything buyer-related) stripped, bad `kind` drops the object. `draftId` accepts any string up to 128 characters so the app can derive split-draft ids.
- `models.ts`: structured schemas built with `zodTextFormat` emitted `nullable: true` and `maxLength`, which are not in OpenAI's strict structured-output subset; rewritten as hand-written schemas like the Telegram pipeline (type unions with null, no length keywords, a test checks this), with token/latency recorded in `ai_usage` and the opt-in eval no longer writing usage rows. A paraphrased `amountSpan` now falls back to the single amount actually spoken (flagged low) instead of a 0 draft. `account` is flagged low only when an account was named but not resolved; before, every voice and receipt draft carried the flag, which would have highlighted the account on every draft.
- `service.ts`: receipt comments are localized by profile language ("Korzinka · 5 позиций"); AI guesses are limited to expense keys; one IKPU lookup per distinct code instead of per line; recent history excludes household rows, transfers and uncommented rows; a malformed Soliq URL is rejected before quota or network; a voice note that yields nothing returns its quota slot.
- `categories.ts`: a model guess was returned as `categoryId: null`, making plan step 4 useless to the user. It now returns the user's own category as a low-confidence suggestion (highlighted, never trusted).
- `capture.routes.ts`: per-feature capability gates; input validation separated from model-output validation (a ZodError from model output is a 502, not the caller's 400); the error body keeps the flat contract shape and also the usual `error` envelope; `not_a_receipt` is a 422.
- `migration.ts`: the projection column became `VIRTUAL` in `utf8mb4_bin` (it was STORED ascii, which rebuilds the table and could fail a transaction write on an odd value).
- `repository.ts`: a missing-migration probe was cached until restart even after a transient DB error; negative results are now retried after 30 s.
- `owner.ts`: the weekly digest would have repeated every unreviewed merchant forever; it now covers merchants first seen in 7 days or with disagreeing voters and says how many.
- `captureEval.ts` / `package.json`: `capture:eval` no longer forces `DOTENV_CONFIG_PATH=/dev/null`, which would have made the server env fail validation.

Discarded: nothing.

## Contract decisions and ambiguities

- Errors are flat as in the brief (`{ code, quota }`, `{ code: 'soliq_unavailable' }`) and also carry `message` and the usual `error: { code, message }`.
- `lowConfidenceFields` never contains `account` unless an account was named and not resolved. `accountId: null` means "app pre-fills its default".
- A model category guess is returned with `categoryId` set, `categoryConfidence: 'low'` and `category` in `lowConfidenceFields` (highlighted suggestion). With no matching user category it is `null`. Voice drafts with an unsure category stay `null` as the brief says.
- A learning vote is single when the suggestion was kept or there was no suggestion, double when the user changed it.
- Quota limit is 5 free / 300 Premium for voice and photo; Soliq is free unless `CAPTURE_COUNT_SOLIQ`. A voice note with no operations, and any failed call, does not use a slot.
- Receipt `comment` is localized on the server by profile language (ru/uz/en); the app may overwrite it.
- Soliq money fields are assumed to be in sum. If real receipts turn out to be in tiyin, set `SOLIQ_AMOUNT_DIVISOR=100` and clear `capture_receipt_cache`. Nobody has checked this against a real receipt.

## Verified

- `DOTENV_CONFIG_PATH=/dev/null npm run typecheck`, `npm test` (76 files passed, 766 tests passed, 53 skipped MySQL integration tests) and `npm run build` all pass on the final tree. `npm run lint` shows only the existing `scripts/clean-dist.cjs` errors.
- 241 capture tests: parser and corpus, Soliq URLs (all variants), signature, mapping, buyer-field stripping, cache, retry and timeout; category inference order; quota boundaries and the month and year rollover in Tashkent; duplicate lookup scoping; learning (single and double vote, voter hashing, replacement of a repeat vote, personal categories never voting); post-commit learning not running for replays, rollbacks or legacy clients; capability gating in `/v1/sync/capabilities` and per route; guests rejected; multipart limits and media checks over real HTTP; error contract and no provider text in responses; owner digest scheduling and claim; migration is additive and self-contained.
- Existing transaction create, PATCH and household bodies parse exactly as before.

## Not verified

- The migration SQL has not run on a real MySQL (no Docker daemon was available for the rehearsal DB). Syntax and semantics were reviewed by hand and through a recording mock only. Run it first on the rehearsal DB (`compose.migration.yaml`, `npm run test:mysql` stays untouched) and check `EXPLAIN` of the duplicate lookup.
- Nothing was called against OpenAI or Soliq. The strict JSON schemas, `reasoning`/`verbosity` parameters, the Soliq response shape, the `X-Signature` scheme and the money unit are unverified against the live services. Model accuracy per field is unmeasured.
- m4a duration parsing was tested on hand-built containers, not on a real recording from the app. A fragmented MP4 (duration 0 in `mdhd`) would be rejected.
- The IKPU seed prefixes come from Codex's reading of the Cabinet resolution and were not re-checked against real receipts.
- No end-to-end run with the app (Part B). Concurrency of quota and voting is covered by the SQL design (conditional UPDATE, row lock on the merchant), not by a concurrent test.
