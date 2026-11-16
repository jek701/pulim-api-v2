import { z } from 'zod';
import { runSqlTransaction } from '../db/documents';
import { profileRef } from '../repositories/profile.repository';
import { AppError } from '../utils/AppError';
export const consentTypeSchema = z.literal('ai');
export const consentBodySchema = z
  .object({
    granted: z.boolean(),
    version: z.string().min(1).max(20),
    language: z.enum(['ru', 'uz', 'en']),
    screen: z.enum(['sheet', 'settings']),
    at: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export async function putConsent(
  uid: string,
  input: z.infer<typeof consentBodySchema>,
): Promise<void> {
  await runSqlTransaction(async (tx) => {
    const ref = profileRef(uid);
    const profile = await tx.read(ref);
    if (!profile.exists) throw AppError.notFound('Profile not found.');
    const now = Date.now();
    const previous = profile.data.consents?.ai;
    // A retry without a client timestamp must not invent a later consent event.
    if (
      previous &&
      previous.granted === input.granted &&
      previous.version === input.version &&
      previous.language === input.language &&
      previous.screen === input.screen &&
      (input.at === undefined ||
        previous.at ===
          Math.max(previous.serverAt - 86400000, Math.min(previous.serverAt + 86400000, input.at)))
    )
      return;
    const at = Math.max(now - 86400000, Math.min(now + 86400000, input.at ?? now));
    tx.patch(ref, {
      'consents.ai': {
        ...input,
        at,
        serverAt: now,
        revokedAt: input.granted
          ? null
          : previous?.granted === true
            ? now
            : (previous?.revokedAt ?? null),
      },
      updatedAt: now,
    });
  });
}
