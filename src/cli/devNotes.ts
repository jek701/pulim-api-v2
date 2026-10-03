/**
 * Claude's side of the dev-notes loop. Runs on the server (where Firestore
 * credentials already live) over SSH, so no secrets are needed on the Mac:
 *
 *   node dist/cli/devNotes.js pending                     JSON list of notes to work on
 *   node dist/cli/devNotes.js show <id>                   one note as JSON
 *   node dist/cli/devNotes.js screenshot <id>             raw image bytes to stdout
 *   node dist/cli/devNotes.js claim <id>...               mark notes in_progress
 *   node dist/cli/devNotes.js release <id>...             return claimed notes to the queue
 *   node dist/cli/devNotes.js resolve <id> --status done|needs_reply|rejected [--commit <sha>]...
 *                                                         reply text is read from stdin
 *   node dist/cli/devNotes.js find-uid --telegram-username <name>
 */
import { db } from '../config/firebase';
import { RESOLVED_STATUSES, type DevNoteResolution } from '../devNotes/domain';
import {
  claimDevNote,
  getDevNote,
  getScreenshot,
  listPendingDevNotes,
  releaseDevNote,
  resolveDevNote,
} from '../devNotes/devNotes.repository';

const STALE_CLAIM_MS = 3 * 60 * 60 * 1_000;

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg === flag && args[index + 1]) values.push(args[index + 1]!);
  });
  return values;
}

function positional(args: string[]): string[] {
  return args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const ids = positional(args);

  switch (command) {
    case 'pending':
      print(await listPendingDevNotes(STALE_CLAIM_MS));
      return;
    case 'show':
      print(await getDevNote(ids[0] ?? ''));
      return;
    case 'screenshot': {
      const dataUrl = await getScreenshot(ids[0] ?? '');
      if (!dataUrl) throw new Error('No screenshot for this note.');
      process.stdout.write(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      return;
    }
    case 'claim':
      print({ claimed: (await Promise.all(ids.map(async (id) => (await claimDevNote(id)) && id))).filter(Boolean) });
      return;
    case 'release':
      await Promise.all(ids.map(releaseDevNote));
      print({ released: ids });
      return;
    case 'resolve': {
      const status = flagValues(args, '--status')[0] as DevNoteResolution | undefined;
      if (!status || !RESOLVED_STATUSES.includes(status)) {
        throw new Error(`--status must be one of ${RESOLVED_STATUSES.join(', ')}`);
      }
      const message = await readStdin();
      if (!message) throw new Error('Reply text is required on stdin.');
      const note = await resolveDevNote({ id: ids[0] ?? '', status, message, commits: flagValues(args, '--commit') });
      print({ id: note.id, status: note.status, reopenedByOwner: note.status !== status });
      return;
    }
    case 'find-uid': {
      const username = flagValues(args, '--telegram-username')[0]?.replace(/^@/, '');
      if (!username) throw new Error('--telegram-username is required');
      const snap = await db.collection('telegramUsers').where('username', '==', username).get();
      print(snap.docs.map((doc) => doc.get('profileUid') ?? doc.get('uid')));
      return;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". See the header of src/cli/devNotes.ts.`);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
