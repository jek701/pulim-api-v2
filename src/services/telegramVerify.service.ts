import crypto from 'node:crypto';
import { logger } from '../utils/logger';

// Telegram's Ed25519 public keys (prod + test). Ported from the old JS backend.
const TELEGRAM_PUBLIC_KEYS = [
  'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec',
];

export type ParsedInitData = Record<string, string>;

function buildDataCheckString(initData: ParsedInitData): string {
  return Object.entries(initData)
    .filter(([key, value]) => key !== 'hash' && key !== 'signature' && value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function buildSignatureCheckString(initData: ParsedInitData, botId: string): string {
  return `${botId}:WebAppData\n${buildDataCheckString(initData)}`;
}

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, 'base64');
}

function createEd25519PublicKey(rawHexKey: string): crypto.KeyObject {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const rawKey = Buffer.from(rawHexKey, 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, rawKey]),
    format: 'der',
    type: 'spki',
  });
}

function verifyTelegramSignature(
  parsed: ParsedInitData,
  options: { debug?: boolean; botId: string | null },
): boolean {
  const { debug = false, botId } = options;
  if (!parsed.signature || !botId) return false;

  const signatureCheckString = buildSignatureCheckString(parsed, botId);
  const signature = base64UrlToBuffer(parsed.signature);

  const isValid = TELEGRAM_PUBLIC_KEYS.some((hexKey) => {
    const publicKey = createEd25519PublicKey(hexKey);
    return crypto.verify(null, Buffer.from(signatureCheckString), publicKey, signature);
  });

  if (debug) {
    logger.info({ botId, signatureCheckString, signatureVerified: isValid }, 'Telegram signature debug');
  }
  return isValid;
}

function parseInitData(rawInitData: string): ParsedInitData {
  const params = new URLSearchParams(rawInitData);
  const parsed: ParsedInitData = {};
  for (const [key, value] of params.entries()) parsed[key] = value;
  return parsed;
}

/**
 * Verifies a Telegram Mini App `initData` payload (HMAC-SHA256, with Ed25519
 * signature fallback). Returns the parsed fields on success; throws otherwise.
 */
export function verifyTelegramInitData(
  rawInitData: string,
  botToken: string,
  options: { debug?: boolean } = {},
): ParsedInitData {
  const { debug = false } = options;
  if (!rawInitData) throw new Error('Telegram init data is required.');

  const parsed = parseInitData(rawInitData);
  const providedHash = parsed.hash;
  const botId = botToken ? botToken.split(':')[0] : null;

  if (!providedHash) throw new Error('Telegram init data hash is missing.');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = buildDataCheckString(parsed);
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (debug) {
    logger.info(
      { botId, parsedKeys: Object.keys(parsed).sort(), providedHash, calculatedHash },
      'Telegram auth debug',
    );
  }

  if (calculatedHash !== providedHash) {
    if (verifyTelegramSignature(parsed, { debug, botId })) return parsed;
    throw new Error('Telegram init data hash is invalid.');
  }

  return parsed;
}
