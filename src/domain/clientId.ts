import { z } from 'zod';

/**
 * Ids chosen by offline clients (UUID/ULID friendly). Server-generated ids are exactly
 * 20 alphanumerics, Telegram-created documents start with `telegram_`, default
 * categories and special category ids contain `__`; none of those may be claimed.
 */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export function isValidClientId(id: string): boolean {
  return (
    CLIENT_ID_PATTERN.test(id) &&
    !/^[A-Za-z0-9]{20}$/.test(id) &&
    !id.includes('__') &&
    !id.startsWith('telegram_')
  );
}
export const clientIdSchema = z
  .string()
  .refine(isValidClientId, 'Invalid client id (use a UUID or ULID, 8-64 chars of A-Za-z0-9_-).');
