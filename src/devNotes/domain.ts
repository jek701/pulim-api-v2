import { z } from 'zod';

/**
 * Dev notes: the owner's private improvement queue. Notes are filed from the
 * in-app widget or the `/idea` bot command and picked up by Claude through
 * `src/cli/devNotes.ts`, which implements them, deploys and reports back.
 */
export const DEV_NOTE_STATUSES = ['new', 'in_progress', 'done', 'needs_reply', 'rejected'] as const;
export type DevNoteStatus = (typeof DEV_NOTE_STATUSES)[number];
export const RESOLVED_STATUSES = ['done', 'needs_reply', 'rejected'] as const;
export type DevNoteResolution = (typeof RESOLVED_STATUSES)[number];

export const MAX_THREAD_MESSAGES = 50;
/** Keeps the screenshot doc under Firestore's 1 MiB limit and the 1 MB JSON body limit. */
export const MAX_SCREENSHOT_CHARS = 900_000;

export interface DevNoteMessage {
  author: 'owner' | 'claude';
  text: string;
  at: number;
}

const short = (max: number) => z.string().trim().max(max);

export const devNoteContextSchema = z.object({
  tab: short(64).optional(),
  url: short(500).optional(),
  modal: short(200).optional(),
  headings: z.array(short(200)).max(6).optional(),
  selector: short(1_000).optional(),
  elementTag: short(40).optional(),
  elementText: short(500).optional(),
  elementLabel: short(200).optional(),
  rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  }).strict().optional(),
  viewport: z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    dpr: z.number().finite().positive(),
  }).strict().optional(),
  theme: short(20).optional(),
  language: short(10).optional(),
  userAgent: short(400).optional(),
  appBuild: short(64).optional(),
}).strict();

export type DevNoteContext = z.infer<typeof devNoteContextSchema>;

export const devNoteCreateSchema = z.object({
  comment: z.string().trim().min(1).max(4_000),
  context: devNoteContextSchema.optional(),
  screenshot: z.string()
    .max(MAX_SCREENSHOT_CHARS)
    .regex(/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/)
    .optional(),
}).strict();

export const devNoteReplySchema = z.object({
  text: z.string().trim().min(1).max(4_000),
}).strict();

export interface DevNote {
  id: string;
  userId: string;
  source: 'app' | 'telegram';
  comment: string;
  status: DevNoteStatus;
  context: DevNoteContext | null;
  hasScreenshot: boolean;
  thread: DevNoteMessage[];
  commits: string[];
  createdAt: number;
  updatedAt: number;
  claimedAt?: number | null;
  resolvedAt?: number | null;
}

/** Any owner reply puts the note back in the queue, including mid-processing. */
export function statusAfterOwnerReply(): DevNoteStatus {
  return 'new';
}

/**
 * Claude's verdict only lands if the note is still claimed. When the owner
 * replied while Claude was working, the note stays `new` so the reply is not lost.
 */
export function statusAfterResolve(current: DevNoteStatus, requested: DevNoteResolution): DevNoteStatus {
  return current === 'in_progress' ? requested : current;
}

export function appendMessage(thread: DevNoteMessage[], message: DevNoteMessage): DevNoteMessage[] {
  return [...thread, message].slice(-MAX_THREAD_MESSAGES);
}
