import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { ClientHttp2Session, OutgoingHttpHeaders, connect } from 'node:http2';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env', () => ({ env: {} }));
vi.mock('../../src/utils/logger', () => ({ logger: { error: vi.fn() } }));

import { classifyApnsResponse, createApnsSender, Http2ApnsTransport, type ApnsConfig } from '../../src/push/apns';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const syntheticKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
const config: ApnsConfig = {
  PUSH_ENABLED: true, APNS_KEY_ID: 'TESTKEY', APNS_TEAM_ID: 'TESTTEAM',
  APNS_KEY_PATH: 'synthetic-in-memory', APNS_BUNDLE_ID: 'com.test.default',
};
const device = { token: 'ab'.repeat(32), environment: 'sandbox' as const, bundleId: 'com.test.pulim' };
const payload = { aps: { alert: { title: 'Reminder', body: 'Test' } }, type: 'subscription_due' };

function setup(overrides: Partial<ApnsConfig> = {}) {
  let time = 1_800_000_000_000;
  const send = vi.fn().mockResolvedValue({ status: 200, apnsId: 'test-id' });
  const loadKey = vi.fn().mockResolvedValue(syntheticKey);
  const error = vi.fn();
  const sender = createApnsSender({ ...config, ...overrides }, { transport: { send }, loadKey, now: () => time, log: { error } });
  return { sender, send, loadKey, error, advance: (ms: number) => { time += ms; } };
}

describe('APNs sender', () => {
  it('uses native hosts, alert headers, expiration and collapse id', async () => {
    const { sender, send } = setup();
    expect(await sender.send(device, payload, { expiration: 123, collapseId: 'budget:food' })).toEqual({ status: 200, apnsId: 'test-id' });
    expect(send).toHaveBeenCalledWith('https://api.sandbox.push.apple.com', expect.objectContaining({
      ':method': 'POST', ':path': `/3/device/${device.token}`,
      'apns-topic': 'com.test.pulim', 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-expiration': '123', 'apns-collapse-id': 'budget:food',
    }), JSON.stringify(payload));
    await sender.send({ ...device, environment: 'production' }, payload);
    expect(send.mock.calls[1][0]).toBe('https://api.push.apple.com');
  });

  it('signs valid ES256 JWTs and shares one cached token across concurrent sends for 50 minutes', async () => {
    const { sender, send, loadKey, advance } = setup();
    await Promise.all([sender.send(device, payload), sender.send(device, payload)]);
    const authorization = send.mock.calls[0][1].authorization as string;
    expect(send.mock.calls[1][1].authorization).toBe(authorization);
    const [header, claims, signature] = authorization.slice('bearer '.length).split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'TESTKEY' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TESTTEAM', iat: 1_800_000_000 });
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
    advance(50 * 60_000 - 1);
    await sender.send(device, payload);
    expect(loadKey).toHaveBeenCalledOnce();
    advance(1);
    await sender.send(device, payload);
    expect(loadKey).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[3][1].authorization).not.toBe(authorization);
  });

  it.each(['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_PATH'] as const)('disables push safely when %s is absent', async (field) => {
    const { sender, send, loadKey } = setup({ [field]: '' });
    expect(sender.configured()).toBe(false);
    expect(await sender.send(device, payload)).toEqual({ status: 503, reason: 'ProviderNotConfigured' });
    expect(send).not.toHaveBeenCalled();
    expect(loadKey).not.toHaveBeenCalled();
  });

  it('does not load credentials while PUSH_ENABLED is false', async () => {
    const { sender, loadKey } = setup({ PUSH_ENABLED: false });
    expect(sender.configured()).toBe(false);
    await sender.send(device, payload);
    expect(loadKey).not.toHaveBeenCalled();
  });

  it('pauses on provider authentication errors until a fresh JWT is generated', async () => {
    const { sender, send, error, advance } = setup();
    send.mockResolvedValueOnce({ status: 403, reason: 'InvalidProviderToken' });
    expect(await sender.send(device, payload)).toEqual({ status: 403, reason: 'InvalidProviderToken' });
    expect(await sender.send(device, payload)).toEqual({ status: 503, reason: 'ProviderTokenCircuitOpen' });
    expect(send).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).not.toContain(device.token);
    advance(50 * 60_000);
    expect(await sender.send(device, payload)).toMatchObject({ status: 200 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1].authorization).not.toBe(send.mock.calls[0][1].authorization);
  });

  it('contains key read/sign failures without logging credentials or thrown errors', async () => {
    const { sender, loadKey, send, error } = setup();
    loadKey.mockRejectedValueOnce(new Error('secret-key-path-and-content'));
    expect(await sender.send(device, payload)).toEqual({ status: 503, reason: 'ProviderCredentialsUnavailable' });
    expect(await sender.send(device, payload)).toMatchObject({ status: 503, reason: 'ProviderTokenCircuitOpen' });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-key-path-and-content');
    expect(JSON.stringify(error.mock.calls)).not.toContain(config.APNS_KEY_PATH);
  });

  it('returns retryable transport failures without opening the auth circuit', async () => {
    const { sender, send } = setup();
    send.mockRejectedValueOnce(new Error('network'));
    expect(await sender.send(device, payload)).toEqual({ status: 503, reason: 'TransportError' });
    expect(await sender.send(device, payload)).toMatchObject({ status: 200 });
  });

  it('rejects oversized payloads and multibyte collapse ids before transport', async () => {
    const { sender, send } = setup();
    expect(await sender.send(device, { text: 'я'.repeat(3000) })).toMatchObject({ status: 413 });
    expect(await sender.send(device, payload, { collapseId: 'я'.repeat(33) })).toMatchObject({ reason: 'BadCollapseId' });
    expect(await sender.send(device, payload, { expiration: -1 })).toMatchObject({ reason: 'BadExpirationDate' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [200, undefined, 'success'], [410, 'Unregistered', 'disable'], [410, 'ExpiredToken', 'disable'],
    [400, 'BadDeviceToken', 'disable'], [400, 'DeviceTokenNotForTopic', 'disable'],
    [429, 'TooManyRequests', 'retry'], [500, 'InternalServerError', 'retry'], [503, 'Shutdown', 'retry'],
    [403, 'InvalidProviderToken', 'auth'], [413, 'PayloadTooLarge', 'permanent'],
  ] as const)('classifies status %s / %s as %s', (status, reason, expected) => {
    expect(classifyApnsResponse({ status, reason })).toBe(expected);
  });
});

class FakeStream extends EventEmitter {
  timeout?: () => void;
  setEncoding() {}
  setTimeout(_ms: number, callback: () => void) { this.timeout = callback; }
  close() { this.emit('close'); }
  end() {
    queueMicrotask(() => {
      this.emit('response', { ':status': 410, 'apns-id': 'id-123' });
      this.emit('data', '{"reason":"Unregistered"}');
      this.emit('end');
      this.emit('close');
    });
  }
}
class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  streams: FakeStream[] = [];
  request(_headers: OutgoingHttpHeaders) { const stream = new FakeStream(); this.streams.push(stream); return stream; }
  setTimeout() {}
  close() { this.closed = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

describe('persistent APNs HTTP/2 transport', () => {
  function setupTransport() {
    const sessions: FakeSession[] = [];
    const open = vi.fn((_host: string) => { const session = new FakeSession(); sessions.push(session); return session as unknown as ClientHttp2Session; });
    const transport = new Http2ApnsTransport(open as unknown as typeof connect);
    return { transport, open, sessions };
  }

  it('reuses each environment session and parses APNs response fields', async () => {
    const { transport, open } = setupTransport();
    expect(await transport.send('sandbox', {}, '{}')).toEqual({ status: 410, reason: 'Unregistered', apnsId: 'id-123' });
    await transport.send('sandbox', {}, '{}');
    await transport.send('production', {}, '{}');
    expect(open.mock.calls.map(([host]) => host)).toEqual(['sandbox', 'production']);
    transport.close();
  });

  it.each(['goaway', 'error', 'close'])('reconnects after %s without a duplicate immediate send', async (event) => {
    const { transport, sessions, open } = setupTransport();
    await transport.send('sandbox', {}, '{}');
    sessions[0].emit(event, event === 'error' ? new Error('connection') : undefined);
    await transport.send('sandbox', {}, '{}');
    expect(open).toHaveBeenCalledTimes(2);
    expect(sessions.map((session) => session.streams.length)).toEqual([1, 1]);
    transport.close();
  });

  it('resolves connection and request errors as transient failures', async () => {
    const transport = new Http2ApnsTransport((() => { throw new Error('connect'); }) as unknown as typeof connect);
    expect(await transport.send('sandbox', {}, '{}')).toEqual({ status: 503, reason: 'TransportError' });
    const { transport: other, sessions } = setupTransport();
    const pending = other.send('sandbox', {}, '{}');
    sessions[0].streams[0].emit('error', new Error('stream'));
    expect(await pending).toEqual({ status: 503, reason: 'TransportError' });
    other.close();
  });

  it('bounds stream timeouts and handles closed streams without hanging', async () => {
    const { transport, sessions } = setupTransport();
    const pending = transport.send('sandbox', {}, '{}');
    sessions[0].streams[0].timeout!();
    expect(await pending).toEqual({ status: 503, reason: 'TransportTimeout' });
    const closed = transport.send('sandbox', {}, '{}');
    sessions[0].streams[1].emit('close');
    expect(await closed).toEqual({ status: 503, reason: 'TransportClosed' });
    transport.close();
  });
});
