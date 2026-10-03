import { describe, expect, it } from 'vitest';
import {
  appendMessage,
  devNoteCreateSchema,
  MAX_THREAD_MESSAGES,
  statusAfterResolve,
} from '../../src/devNotes/domain';

describe('dev notes', () => {
  it('applies a resolution only while the note is claimed', () => {
    expect(statusAfterResolve('in_progress', 'done')).toBe('done');
    // The owner replied mid-processing: keep it queued so the reply gets read.
    expect(statusAfterResolve('new', 'done')).toBe('new');
  });

  it('caps the thread length', () => {
    const thread = Array.from({ length: MAX_THREAD_MESSAGES }, (_, at) => ({ author: 'owner' as const, text: 'x', at }));
    const next = appendMessage(thread, { author: 'claude', text: 'last', at: 999 });
    expect(next).toHaveLength(MAX_THREAD_MESSAGES);
    expect(next.at(-1)?.text).toBe('last');
  });

  it('accepts a minimal note and rejects unknown fields', () => {
    expect(devNoteCreateSchema.safeParse({ comment: 'Bigger button' }).success).toBe(true);
    expect(devNoteCreateSchema.safeParse({ comment: 'x', userId: 'someone' }).success).toBe(false);
    expect(devNoteCreateSchema.safeParse({ comment: '   ' }).success).toBe(false);
  });

  it('only accepts base64 image data urls as screenshots', () => {
    expect(devNoteCreateSchema.safeParse({ comment: 'x', screenshot: 'data:image/jpeg;base64,AAAA' }).success).toBe(true);
    expect(devNoteCreateSchema.safeParse({ comment: 'x', screenshot: 'https://example.com/a.png' }).success).toBe(false);
  });
});
