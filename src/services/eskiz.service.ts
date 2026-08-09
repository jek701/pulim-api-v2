import { env, eskizConfigured } from '../config/env';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

/**
 * Eskiz.uz SMS gateway client.
 * Docs: https://documenter.getpostman.com/view/663428/RzfmES4z
 *
 * Auth is a bearer token obtained with the cabinet email/password and valid for
 * ~30 days, so it is cached in memory and re-issued lazily: `PATCH /auth/refresh`
 * first, full `POST /auth/login` if the refresh is rejected. A 401 on a send
 * invalidates the cache and the send is retried once.
 */

interface EskizTokenResponse {
  message?: string;
  data?: { token?: string };
}

interface EskizSendResponse {
  id?: string;
  message?: string;
  status?: string;
}

export interface SentSms {
  /** Eskiz request id (UUID) — usable with GET /message/sms/status_by_id/:id. */
  requestId: string | null;
  status: string | null;
}

let cachedToken: string | null = null;
/** In-flight token request, shared so concurrent sends trigger a single login. */
let tokenInFlight: Promise<string> | null = null;

const url = (path: string) => `${env.ESKIZ_BASE_URL.replace(/\/+$/, '')}${path}`;

function assertConfigured(): void {
  if (!eskizConfigured) {
    throw new AppError(
      503,
      'SMS_UNAVAILABLE',
      'The SMS gateway is not configured (ESKIZ_EMAIL / ESKIZ_PASSWORD are missing).',
    );
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

async function login(): Promise<string> {
  const response = await fetch(url('/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: env.ESKIZ_EMAIL, password: env.ESKIZ_PASSWORD }),
    signal: AbortSignal.timeout(env.ESKIZ_TIMEOUT_MS),
  });
  const payload = await readJson<EskizTokenResponse>(response);
  const token = payload.data?.token;
  if (!response.ok || !token) {
    logger.error({ status: response.status, message: payload.message }, '[eskiz] login failed');
    throw new AppError(502, 'SMS_GATEWAY_ERROR', 'Could not authenticate with the SMS gateway.');
  }
  return token;
}

async function refresh(token: string): Promise<string | null> {
  try {
    const response = await fetch(url('/api/auth/refresh'), {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(env.ESKIZ_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await readJson<EskizTokenResponse>(response)).data?.token ?? null;
  } catch {
    return null;
  }
}

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (!tokenInFlight) {
    tokenInFlight = login()
      .then((token) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        tokenInFlight = null;
      });
  }
  return tokenInFlight;
}

/** Drops the cached token, trying a cheap refresh before the next full login. */
async function invalidateToken(): Promise<void> {
  const stale = cachedToken;
  cachedToken = null;
  if (!stale) return;
  const refreshed = await refresh(stale);
  if (refreshed) cachedToken = refreshed;
}

async function postSend(token: string, phone: string, message: string): Promise<Response> {
  const body = new URLSearchParams({
    mobile_phone: phone,
    message,
    from: env.ESKIZ_FROM,
  });
  if (env.ESKIZ_CALLBACK_URL) body.set('callback_url', env.ESKIZ_CALLBACK_URL);

  return fetch(url('/api/message/sms/send'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(env.ESKIZ_TIMEOUT_MS),
  });
}

/**
 * Sends one SMS. `phone` must be bare digits in international format without `+`
 * (e.g. `998901234567`) — that is what Eskiz expects in `mobile_phone`.
 */
export async function sendSms(phone: string, message: string): Promise<SentSms> {
  assertConfigured();

  let response: Response;
  try {
    response = await postSend(await getToken(), phone, message);
    if (response.status === 401) {
      await invalidateToken();
      response = await postSend(await getToken(), phone, message);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ err: error }, '[eskiz] send request failed');
    throw new AppError(502, 'SMS_GATEWAY_ERROR', 'The SMS gateway is unreachable.');
  }

  const payload = await readJson<EskizSendResponse>(response);
  if (!response.ok) {
    logger.error(
      { status: response.status, message: payload.message },
      '[eskiz] send rejected',
    );
    // 400 here is almost always an unapproved message template or a bad number.
    throw new AppError(502, 'SMS_SEND_FAILED', 'The SMS gateway rejected the message.');
  }

  logger.info({ requestId: payload.id, status: payload.status }, '[eskiz] sms queued');
  return { requestId: payload.id ?? null, status: payload.status ?? null };
}

/** Current SMS balance — handy for a health check or an ops alert. */
export async function getBalance(): Promise<number | null> {
  assertConfigured();
  const response = await fetch(url('/api/user/get-limit'), {
    headers: { authorization: `Bearer ${await getToken()}` },
    signal: AbortSignal.timeout(env.ESKIZ_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const payload = await readJson<{ data?: { balance?: number } }>(response);
  return payload.data?.balance ?? null;
}
