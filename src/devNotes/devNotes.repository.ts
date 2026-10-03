import { db } from '../config/firebase';
import { AppError } from '../utils/AppError';
import {
  appendMessage,
  statusAfterOwnerReply,
  statusAfterResolve,
  type DevNote,
  type DevNoteContext,
  type DevNoteResolution,
} from './domain';

const notes = () => db.collection('devNotes');
// Screenshots live apart so listing notes never drags ~100 KB images along.
const screenshots = () => db.collection('devNoteScreenshots');

const toNote = (snap: FirebaseFirestore.DocumentSnapshot): DevNote => ({
  id: snap.id,
  ...(snap.data() as Omit<DevNote, 'id'>),
});

export async function createDevNote(input: {
  uid: string;
  source: DevNote['source'];
  comment: string;
  context?: DevNoteContext;
  screenshot?: string;
}): Promise<DevNote> {
  const now = Date.now();
  const ref = notes().doc();
  const note: Omit<DevNote, 'id'> = {
    userId: input.uid,
    source: input.source,
    comment: input.comment,
    status: 'new',
    context: input.context ?? null,
    hasScreenshot: Boolean(input.screenshot),
    thread: [],
    commits: [],
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    resolvedAt: null,
  };
  const batch = db.batch();
  batch.set(ref, note);
  if (input.screenshot) {
    batch.set(screenshots().doc(ref.id), { userId: input.uid, dataUrl: input.screenshot, createdAt: now });
  }
  await batch.commit();
  return { id: ref.id, ...note };
}

export async function listOwnDevNotes(uid: string, limit = 100): Promise<DevNote[]> {
  const snap = await notes().where('userId', '==', uid).get();
  return snap.docs.map(toNote).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

async function requireOwned(uid: string, id: string) {
  const ref = notes().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw AppError.notFound();
  if (snap.get('userId') !== uid) throw AppError.notFound();
  return ref;
}

export async function getOwnScreenshot(uid: string, id: string): Promise<string> {
  await requireOwned(uid, id);
  const snap = await screenshots().doc(id).get();
  if (!snap.exists) throw AppError.notFound('Screenshot not found.');
  return snap.get('dataUrl') as string;
}

export async function addOwnerReply(uid: string, id: string, text: string): Promise<DevNote> {
  const ref = await requireOwned(uid, id);
  return db.runTransaction(async (tx) => {
    const note = toNote(await tx.get(ref));
    const now = Date.now();
    const patch = {
      thread: appendMessage(note.thread ?? [], { author: 'owner', text, at: now }),
      status: statusAfterOwnerReply(),
      resolvedAt: null,
      updatedAt: now,
    };
    tx.update(ref, patch);
    return { ...note, ...patch };
  });
}

export async function deleteOwnDevNote(uid: string, id: string): Promise<void> {
  const ref = await requireOwned(uid, id);
  const batch = db.batch();
  batch.delete(ref);
  batch.delete(screenshots().doc(id));
  await batch.commit();
}

// ── Claude-side operations (CLI only, not exposed over HTTP) ──────────────────

/** Notes waiting for work: `new`, plus claims abandoned for longer than `staleMs`. */
export async function listPendingDevNotes(staleMs: number): Promise<DevNote[]> {
  const snap = await notes().where('status', 'in', ['new', 'in_progress']).get();
  const cutoff = Date.now() - staleMs;
  return snap.docs
    .map(toNote)
    .filter((note) => note.status === 'new' || (note.claimedAt ?? 0) < cutoff)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getDevNote(id: string): Promise<DevNote> {
  const snap = await notes().doc(id).get();
  if (!snap.exists) throw AppError.notFound(`Dev note ${id} not found.`);
  return toNote(snap);
}

export async function getScreenshot(id: string): Promise<string | null> {
  const snap = await screenshots().doc(id).get();
  return snap.exists ? (snap.get('dataUrl') as string) : null;
}

export async function claimDevNote(id: string): Promise<boolean> {
  const ref = notes().doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const now = Date.now();
    tx.update(ref, { status: 'in_progress', claimedAt: now, updatedAt: now });
    return true;
  });
}

export async function releaseDevNote(id: string): Promise<void> {
  const ref = notes().doc(id);
  await db.runTransaction(async (tx) => {
    const note = toNote(await tx.get(ref));
    if (note.status !== 'in_progress') return;
    tx.update(ref, { status: 'new', claimedAt: null, updatedAt: Date.now() });
  });
}

export async function resolveDevNote(input: {
  id: string;
  status: DevNoteResolution;
  message: string;
  commits: string[];
}): Promise<DevNote> {
  const ref = notes().doc(input.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw AppError.notFound(`Dev note ${input.id} not found.`);
    const note = toNote(snap);
    const now = Date.now();
    const status = statusAfterResolve(note.status, input.status);
    const patch = {
      status,
      thread: appendMessage(note.thread ?? [], { author: 'claude', text: input.message, at: now }),
      commits: [...new Set([...(note.commits ?? []), ...input.commits])],
      resolvedAt: status === input.status ? now : null,
      updatedAt: now,
    };
    tx.update(ref, patch);
    return { ...note, ...patch };
  });
}
