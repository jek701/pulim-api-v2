import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import { connect, constants, type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const TOKEN_TTL_MS = 50 * 60_000;
const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

export interface ApnsDevice {
  token: string;
  environment: 'sandbox' | 'production';
  bundleId: string;
}
export interface ApnsResult {
  status: number;
  reason?: string;
  apnsId?: string;
  /** Epoch milliseconds: defer without consuming delivery attempts during a provider outage. */
  retryAt?: number;
}
export interface ApnsOptions { expiration?: number; collapseId?: string }
export interface ApnsConfig {
  PUSH_ENABLED?: boolean;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_PATH?: string;
  APNS_BUNDLE_ID?: string;
}
export interface ApnsTransport {
  send(host: string, headers: OutgoingHttpHeaders, body: string): Promise<ApnsResult>;
  close?(): void;
}

/** Device failures must not retire a working provider credential, or vice versa. */
export function classifyApnsResponse(result: ApnsResult): 'success' | 'disable' | 'retry' | 'auth' | 'permanent' {
  if (result.status === 200) return 'success';
  if (result.status === 410 || ['Unregistered', 'BadDeviceToken', 'BadTopic', 'TopicDisallowed', 'DeviceTokenNotForTopic', 'ExpiredToken'].includes(result.reason ?? '')) return 'disable';
  if (result.status === 403) return 'auth';
  if (result.status === 429 || result.status >= 500) return 'retry';
  return 'permanent';
}

function safeReason(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,80}$/.test(value) ? value : undefined;
}

/** One multiplexed connection per environment. Failed/GOAWAY sessions are replaced on the next send. */
export class Http2ApnsTransport implements ApnsTransport {
  private sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly open: typeof connect = connect) {}

  private session(host: string): ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = this.open(host);
    session.unref();
    this.sessions.set(host, session);
    const forget = () => {
      if (this.sessions.get(host) === session) this.sessions.delete(host);
    };
    session.on('error', () => { forget(); session.destroy(); });
    session.on('close', forget);
    session.on('goaway', () => { forget(); session.close(); });
    session.setTimeout(5 * 60_000, () => { forget(); session.close(); });
    return session;
  }

  async send(host: string, headers: OutgoingHttpHeaders, body: string): Promise<ApnsResult> {
    try {
      const session = this.session(host);
      return await new Promise<ApnsResult>((resolve) => {
        const request = session.request(headers);
        let status = 503;
        let apnsId: string | undefined;
        let response = '';
        let finished = false;
        const finish = (result: ApnsResult) => {
          if (finished) return;
          finished = true;
          resolve(result);
        };
        request.setEncoding('utf8');
        request.on('response', (received) => {
          status = Number(received[':status']) || 503;
          const id = received['apns-id'];
          if (typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id)) apnsId = id;
        });
        request.on('data', (chunk: string) => {
          // APNs errors are tiny. Bound retained data even for a malformed upstream response.
          if (response.length < 8192) response += chunk.slice(0, 8192 - response.length);
        });
        request.on('end', () => {
          let reason: string | undefined;
          try { reason = safeReason(JSON.parse(response).reason); } catch { /* Success has no body. */ }
          finish({ status, reason, apnsId });
        });
        request.on('error', () => finish({ status: 503, reason: 'TransportError' }));
        request.on('close', () => finish({ status: 503, reason: 'TransportClosed' }));
        request.setTimeout(15_000, () => {
          finish({ status: 503, reason: 'TransportTimeout' });
          request.close(constants.NGHTTP2_CANCEL);
        });
        request.end(body);
      });
    } catch {
      return { status: 503, reason: 'TransportError' };
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

interface ApnsDependencies {
  transport?: ApnsTransport;
  now?: () => number;
  loadKey?: (path: string) => Promise<string | Buffer>;
  keyReadable?: (path: string) => boolean;
  log?: Pick<typeof logger, 'error'>;
}

/** Factory keeps credentials, time and transport injectable; tests never load a real key or connect. */
export function createApnsSender(config: ApnsConfig, dependencies: ApnsDependencies = {}) {
  const transport = dependencies.transport ?? new Http2ApnsTransport();
  const now = dependencies.now ?? Date.now;
  const loadKey = dependencies.loadKey ?? ((path: string) => readFile(path));
  const log = dependencies.log ?? logger;
  const keyReadable = dependencies.keyReadable ?? ((path: string) => {
    accessSync(path, fsConstants.R_OK);
    return true;
  });
  // Probe once per process/sender; never advertise a provider whose key cannot be read.
  let available = false;
  if (config.PUSH_ENABLED && config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_KEY_PATH) {
    try {
      available = keyReadable(config.APNS_KEY_PATH);
    } catch { /* No credential values or paths should escape this check. */ }
  }
  let cached: { jwt: string; issuedAt: number } | undefined;
  let generating: Promise<string> | undefined;
  let circuitUntil = 0;

  function configured(): boolean {
    return available;
  }

  async function token(): Promise<string> {
    const time = now();
    if (cached && time >= cached.issuedAt && time - cached.issuedAt < TOKEN_TTL_MS) return cached.jwt;
    if (generating) return generating;
    generating = (async () => {
      const key = createPrivateKey(await loadKey(config.APNS_KEY_PATH!));
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Invalid signing key');
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.APNS_KEY_ID })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: config.APNS_TEAM_ID, iat: Math.floor(time / 1000) })).toString('base64url');
      const unsigned = `${header}.${claims}`;
      const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      cached = { jwt: `${unsigned}.${signature}`, issuedAt: time };
      circuitUntil = 0;
      return cached.jwt;
    })();
    try { return await generating; } finally { generating = undefined; }
  }

  async function send(device: ApnsDevice, payload: object, options: ApnsOptions = {}): Promise<ApnsResult> {
    if (!configured()) return { status: 503, reason: 'ProviderNotConfigured' };
    if (now() < circuitUntil) return { status: 503, reason: 'ProviderTokenCircuitOpen', retryAt: circuitUntil };
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(device.token)) return { status: 400, reason: 'BadDeviceToken' };
    if (!HOSTS[device.environment]) return { status: 400, reason: 'BadEnvironment' };
    if (options.collapseId && Buffer.byteLength(options.collapseId) > 64) return { status: 400, reason: 'BadCollapseId' };
    if (options.expiration !== undefined && (!Number.isSafeInteger(options.expiration) || options.expiration < 0)) return { status: 400, reason: 'BadExpirationDate' };
    let body: string;
    try {
      body = JSON.stringify(payload);
      if (typeof body !== 'string') return { status: 400, reason: 'InvalidPayload' };
    } catch { return { status: 400, reason: 'InvalidPayload' }; }
    if (Buffer.byteLength(body) > 4096) return { status: 413, reason: 'PayloadTooLarge' };
    let authorization: string;
    try { authorization = await token(); } catch {
      circuitUntil = now() + TOKEN_TTL_MS;
      // Never include the key path, credential values, thrown error or device token in logs.
      log.error({ event: 'push.apns.credentials_unavailable' }, 'APNs signing unavailable; sending paused until credential refresh');
      return { status: 503, reason: 'ProviderCredentialsUnavailable', retryAt: circuitUntil };
    }
    let result: ApnsResult;
    try {
      result = await transport.send(HOSTS[device.environment], {
        ':method': 'POST', ':path': `/3/device/${device.token}`,
        authorization: `bearer ${authorization}`,
        'apns-topic': device.bundleId || config.APNS_BUNDLE_ID || 'com.izik.pulim',
        'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-expiration': String(options.expiration ?? Math.floor(now() / 1000) + 86400),
        ...(options.collapseId ? { 'apns-collapse-id': options.collapseId } : {}),
        'content-type': 'application/json',
      }, body);
    } catch {
      return { status: 503, reason: 'TransportError' };
    }
    if (classifyApnsResponse(result) === 'auth') {
      circuitUntil = (cached?.issuedAt ?? now()) + TOKEN_TTL_MS;
      log.error({ event: 'push.apns.auth_rejected', status: 403, reason: safeReason(result.reason) }, 'APNs authentication rejected; sending paused until provider token refresh');
      return { ...result, retryAt: circuitUntil };
    }
    return result;
  }

  return { configured, send, close: () => transport.close?.() };
}

const sender = createApnsSender(env);
export const apnsConfigured = sender.configured;
export const sendApns = sender.send;
export const closeApns = sender.close;
