# Native app login through the Telegram bot

Contract for the "Войти через Telegram" button in the native app (`pulim-react-native`).
The user ends up in the same `tg_<telegramId>` account as in the Mini App: the bot step runs
the same `signInTelegramUser` as `POST /auth/telegram` (same `telegramUsers` mapping,
`profileUid`, and custom claims `provider: 'telegram'`, `telegramId`, `telegramUsername`).

## Flow

1. App → `POST /auth/telegram/login-request` → keeps `requestId` + `deviceSecret` in memory.
2. App opens `deepLink` (`https://t.me/<bot>?start=login_<nonce>`) with `Linking.openURL`.
3. User presses **Start** in the bot. The bot replies "✅ Готово, вернитесь в приложение Pulim…"
   in the user's language, with a "📱 Вернуться в Pulim" URL button.
4. App polls `POST /auth/telegram/login-request/:requestId/exchange` every ~1.5 s
   (while foregrounded) until `approved`, then calls Firebase `signInWithCustomToken(customToken)`.

## Endpoints (public, no `Authorization`)

Errors use the usual envelope `{ "error": { "code", "message", "details?" } }`.

### `POST /auth/telegram/login-request`

Body (optional, may be empty): `{ "language"?: "uz" | "ru" | "en" }`.
The language is used for a brand-new profile and for bot replies to users without a profile.

`201`:

```json
{
  "requestId": "<43 chars, base64url>",
  "deviceSecret": "<43 chars, base64url — keep private, never log>",
  "deepLink": "https://t.me/<bot>?start=login_<32-char nonce>",
  "expiresAt": "2026-10-24T10:05:00.000Z"
}
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | bad `language` |
| 429 | `RATE_LIMITED` | more than 10 requests/min per IP |
| 503 | `TELEGRAM_LOGIN_UNAVAILABLE` | `TELEGRAM_BOT_USERNAME` not configured |

### `POST /auth/telegram/login-request/:requestId/exchange`

Body: `{ "deviceSecret": "<from the create response>" }`.

| Status | Body / code | Meaning |
| --- | --- | --- |
| 200 | `{ "status": "pending", "expiresAt": "<ISO>" }` | bot step not done yet — keep polling |
| 200 | `{ "status": "approved", "customToken": "...", "uid": "tg_…", "isNewUser": false }` | returned **once**; the request is consumed |
| 400 | `VALIDATION_ERROR` | `requestId` is not 43 base64url chars, or no `deviceSecret` |
| 401 | `LOGIN_REQUEST_SECRET_INVALID` | wrong `deviceSecret` (checked before anything else is revealed) |
| 404 | `LOGIN_REQUEST_NOT_FOUND` | unknown `requestId` |
| 410 | `LOGIN_REQUEST_EXPIRED` | expired — start over with a new request |
| 410 | `LOGIN_REQUEST_USED` | token was already handed out (double exchange) |
| 429 | `RATE_LIMITED` | more than 120 checks/min per IP |

Lifetimes: a pending request lives 5 minutes from creation. Once the bot approves it, the app
has another 5 minutes from the approval to exchange it. Stop polling on any 4xx other than 429.

### `GET /auth/telegram/app-return`

Target of the bot's "back to Pulim" button. Telegram URL buttons accept only http(s)/tg://,
so this https page bounces to `TELEGRAM_LOGIN_APP_URL` (default `pulim://`) with a meta refresh
and a visible tap target. The app does not call it.

## Bot

`/start login_<nonce>` in `src/telegram/handlers/login.handler.ts`, routed from
`command.handler.ts` before the linked-user check (it works for new Telegram users too).

- Valid pending request → resolve/create the account, mark the request approved, reply "Готово".
  A repeat `/start` from the same Telegram user (second tap, webhook retry) replies "Готово" again.
- Expired → "⌛ Ссылка для входа устарела…". Unknown, malformed, or approved by another
  Telegram account → "Эта ссылка для входа недействительна или уже использована…".
- `/start`, `/start notify` and every other payload behave as before. Family invites use the
  Mini App `startapp=family_…` parameter and never reach this handler.

## Storage

Table `telegram_login_requests` (`tables.telegramLoginRequests`, generic document schema), created by
`npm run db:migrate` / `db:migrate:prod` (marker `002_telegram_login_requests`). **Run the migration
before deploying**, otherwise the two POST endpoints return 500.
Doc id = `requestId` = SHA-256(nonce), base64url. Stored: `status` (`pending` → `approved` → `consumed`),
`deviceSecretHash` (SHA-256), `language`, `expiresAtMs`, and after approval `telegramId`, `chatId`,
`profileUid`, `claims`, `isNewUser`. The nonce and device secret are never stored. No cleanup job
yet (same as other `expires_at_ms` tables).

## Config

- `TELEGRAM_BOT_USERNAME` (existing) — bot username for the deep link.
- `TELEGRAM_LOGIN_RETURN_URL` (optional, https) — bot button URL. Default:
  `<TELEGRAM_WEBHOOK_URL origin>/auth/telegram/app-return`.
- `TELEGRAM_LOGIN_APP_URL` (default `pulim://`) — where the return page sends the user.
