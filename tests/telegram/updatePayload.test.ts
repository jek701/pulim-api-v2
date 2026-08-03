import { describe, expect, it } from 'vitest';
import { deserializeUpdatePayload, serializeUpdatePayload } from '../../src/telegram/updatePayload';

describe('durable Telegram update payload', () => {
  it('round-trips callback keyboards without storing nested Firestore arrays', () => {
    const update = {
      update_id: 123,
      callback_query: {
        data: 'v1:edit:0',
        message: {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Edit', callback_data: 'v1:edit:0' }],
              [{ text: 'Delete', callback_data: 'v1:del:0' }],
            ],
          },
        },
      },
    };

    const stored = serializeUpdatePayload(update);
    expect(typeof stored).toBe('string');
    expect(deserializeUpdatePayload(stored, null)).toEqual(update);
  });

  it('still reads legacy object payloads and rejects corrupt JSON', () => {
    const legacy = { update_id: 5 };
    expect(deserializeUpdatePayload(undefined, legacy)).toBe(legacy);
    expect(deserializeUpdatePayload('{broken', legacy)).toBeNull();
  });
});
