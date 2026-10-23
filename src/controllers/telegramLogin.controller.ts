import { asyncHandler } from '../utils/asyncHandler';
import { env } from '../config/env';
import { escapeHtml } from '../telegram/render';
import { createTelegramLoginRequest, exchangeTelegramLogin } from '../services/telegramLogin.service';

export const postTelegramLoginRequest = asyncHandler(async (req, res) => {
  res.status(201).json(await createTelegramLoginRequest(req.body));
});

export const postTelegramLoginExchange = asyncHandler(async (req, res) => {
  res.status(200).json(await exchangeTelegramLogin(String(req.params.requestId), req.body.deviceSecret));
});

/**
 * Target of the bot's "back to Pulim" button. Telegram only allows http(s)/tg:// in URL
 * buttons, so this page bounces to the app's custom scheme (meta refresh + a tap target,
 * no script, so it works under the default helmet CSP).
 */
export const getTelegramAppReturn = asyncHandler(async (_req, res) => {
  const appUrl = escapeHtml(env.TELEGRAM_LOGIN_APP_URL).replace(/"/g, '&quot;');
  res
    .status(200)
    .type('html')
    .set('Cache-Control', 'no-store')
    .send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${appUrl}">
<title>Pulim</title>
</head>
<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:48px 16px">
<p><a href="${appUrl}" style="display:inline-block;padding:14px 24px;border-radius:12px;background:#111;color:#fff;text-decoration:none">Pulim</a></p>
<p style="color:#666">Вернитесь в приложение Pulim · Pulim ilovasiga qayting · Return to the Pulim app</p>
</body>
</html>`);
});
