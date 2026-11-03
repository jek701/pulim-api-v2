import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevNote } from '../../src/devNotes/domain';

const repository = vi.hoisted(() => ({ listPendingDevNotes: vi.fn(), getDevNote: vi.fn() }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/db/documents', () => ({}));
vi.mock('../../src/devNotes/devNotes.repository', () => repository);

const legacy: DevNote = {
  id: 'web-note', userId: 'owner', source: 'app', comment: 'Button', status: 'new',
  context: null, hasScreenshot: false, thread: [], commits: [], createdAt: 1, updatedAt: 1,
};
const ios: DevNote = {
  ...legacy, id: 'ios-note', source: 'ios',
  context: { platform: 'ios', route: '/(tabs)/history', appVersion: '1.2.3' },
};

describe('dev notes CLI JSON output', () => {
  const originalArgv = process.argv;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function run(...args: string[]) {
    process.argv = ['node', 'devNotes.js', ...args];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../../src/cli/devNotes');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(stderr).not.toHaveBeenCalled();
    return JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(''));
  }

  it('lists iOS, legacy app and Telegram notes with source/platform/route', async () => {
    const telegram = { ...legacy, id: 'bot-note', source: 'telegram' };
    repository.listPendingDevNotes.mockResolvedValue([ios, legacy, telegram]);
    expect(await run('pending')).toEqual([
      { ...ios, platform: 'ios', route: '/(tabs)/history' },
      { ...legacy, platform: null, route: null },
      { ...telegram, platform: null, route: null },
    ]);
    expect(repository.listPendingDevNotes).toHaveBeenCalledWith(3 * 60 * 60 * 1000);
  });

  it.each([ios, legacy])('shows $id with the full context and routing metadata', async (note) => {
    repository.getDevNote.mockResolvedValue(note);
    expect(await run('show', note.id)).toEqual({
      ...note, platform: note.context?.platform ?? null, route: note.context?.route ?? null,
    });
    expect(repository.getDevNote).toHaveBeenCalledWith(note.id);
  });
});
