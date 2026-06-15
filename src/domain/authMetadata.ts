import type { DecodedToken } from '../config/firebase';
import type { AuthMethod } from './types';

const MODERN_AUTH_METHODS: AuthMethod[] = ['google', 'apple', 'phone'];

function mapProviderIdToAuthMethod(providerId?: string | null): AuthMethod | null {
  switch (providerId) {
    case 'password':
      return 'email';
    case 'google.com':
      return 'google';
    case 'apple.com':
      return 'apple';
    case 'phone':
      return 'phone';
    default:
      return null;
  }
}

function maskPhoneNumber(phoneNumber?: string | null): string | undefined {
  if (!phoneNumber) return undefined;
  if (phoneNumber.length <= 4) return phoneNumber;
  const visible = phoneNumber.slice(-4);
  return `${'•'.repeat(Math.max(phoneNumber.length - 4, 3))}${visible}`;
}

export interface AuthMetadata {
  linkedAuthMethods: AuthMethod[];
  primaryAuthMethod: AuthMethod | null;
  lastAuthMethod: AuthMethod | null;
  legacyEmailLoginAllowed: boolean;
  authMigrationCompleted: boolean;
  authMethodsUpdatedAt: number;
  phoneNumberMasked?: string;
}

/**
 * Server-side equivalent of the auth-metadata sync done client-side in
 * `context.tsx`. Derived from the decoded Firebase ID token claims.
 */
export function deriveAuthMetadata(claims: DecodedToken): AuthMetadata {
  const firebase = claims.firebase as
    | { sign_in_provider?: string; identities?: Record<string, unknown> }
    | undefined;
  const signInProvider = firebase?.sign_in_provider ?? null;
  const identities = firebase?.identities ?? {};
  const isTelegram = claims.provider === 'telegram';

  const methods = new Set<AuthMethod>();
  if (isTelegram) methods.add('telegram');
  if ('email' in identities || claims.email) methods.add('email');
  if ('phone' in identities || claims.phone_number) methods.add('phone');
  if ('google.com' in identities) methods.add('google');
  if ('apple.com' in identities) methods.add('apple');

  const linkedAuthMethods = Array.from(methods);
  const current: AuthMethod | null = isTelegram
    ? 'telegram'
    : (mapProviderIdToAuthMethod(signInProvider) ?? (claims.email ? 'email' : null));

  const primaryAuthMethod =
    linkedAuthMethods.find((m) => MODERN_AUTH_METHODS.includes(m)) ??
    current ??
    linkedAuthMethods[0] ??
    null;

  const hasModern = linkedAuthMethods.some((m) => MODERN_AUTH_METHODS.includes(m));

  const meta: AuthMetadata = {
    linkedAuthMethods,
    primaryAuthMethod,
    lastAuthMethod: current ?? linkedAuthMethods[0] ?? null,
    legacyEmailLoginAllowed: linkedAuthMethods.includes('email'),
    authMigrationCompleted: hasModern,
    authMethodsUpdatedAt: Date.now(),
  };

  const masked = maskPhoneNumber(claims.phone_number as string | undefined);
  if (masked) meta.phoneNumberMasked = masked;

  return meta;
}
