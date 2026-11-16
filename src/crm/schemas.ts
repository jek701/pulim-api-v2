import { z } from 'zod';
// Document ids cannot contain slash. Uids follow Firebase's 128-character contract.
export const crmUid = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('/'));
export const crmMid = z.string().min(1).max(200);
export const crmUsersQuery = z.object({
  cursor: z.string().max(2800).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
  updatedSince: z.coerce.number().int().nonnegative().safe().optional(),
});
export const crmFactsBody = z.object({ uids: z.array(crmUid).min(1).max(200) });
export const crmStatusBody = z.object({ mids: z.array(crmMid).min(1).max(500) });
export const crmMessageBody = z.object({
  mid: crmMid,
  uid: crmUid,
  channel: z.literal('push'),
  category: z.enum(['marketing', 'transactional']),
  title: z.string().min(1).max(50),
  body: z.string().min(1).max(150),
  link: z.string().max(200).startsWith('/'),
  ttlSec: z.number().int().min(60).max(604800).default(86400),
  collapseKey: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 64)
    .optional(),
});
export type CrmMessage = z.infer<typeof crmMessageBody>;
