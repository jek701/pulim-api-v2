/**
 * Firestore rejects Telegram callback payloads because inline_keyboard contains
 * arrays nested inside an array. Store the durable update as JSON instead.
 */
export function serializeUpdatePayload(payload: unknown): string {
  return JSON.stringify(payload);
}

export function deserializeUpdatePayload(payloadJson: unknown, legacyPayload: unknown): unknown {
  if (typeof payloadJson !== 'string') return legacyPayload;
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
}
