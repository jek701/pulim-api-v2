import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ data: {} as any, save: vi.fn() }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (t: string) => t,
  documentKey: (t: string, id: string) => ({ table: t, id }),
  readDocument: async () => ({ id: 'u', exists: true, data: state.data }),
  runSqlTransaction: async (fn: any) =>
    fn({
      read: async () => ({ data: state.data }),
      save: (_ref: any, data: any) => {
        state.save(data);
        state.data = data;
      },
    }),
}));
import { patchSettings, getSettings } from '../../src/controllers/settings.controller';
const ps = (updatedAt: number, extra = {}) => ({
  everydayEnabled: true,
  everydayManual: null,
  accountOverrides: { a: true },
  updatedAt,
  ...extra,
});
beforeEach(() => {
  state.data = { cardOrder: ['a'], planSettings: ps(20, { tipsDoneAt: 15 }) };
  state.save.mockClear();
});
async function patch(body: any) {
  const res = { json: vi.fn() },
    next = vi.fn();
  patchSettings({ uid: 'u', body } as any, res as any, next);
  await vi.waitFor(() => expect(res.json).toHaveBeenCalled());
  expect(next).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0];
}
it('keeps and returns newer stored planSettings but accepts other settings', async () => {
  const r = await patch({ cardOrder: ['b'], planSettings: ps(19) });
  expect(r).toMatchObject({ cardOrder: ['b'], planSettings: ps(20, { tipsDoneAt: 15 }) });
});
it.each([20, 21])('replaces the whole object for equal/newer timestamp %d', async (n) => {
  expect(
    (await patch({ planSettings: ps(n, { accountOverrides: { b: false } }) })).planSettings,
  ).toEqual(ps(n, { accountOverrides: { b: false } }));
});
it('accepts initial settings and leaves legacy patches compatible', async () => {
  state.data = {};
  expect((await patch({ planSettings: ps(0) })).planSettings).toEqual(ps(0));
  expect((await patch({ plannedExpenseVisibility: 'hidden' })).planSettings).toEqual(ps(0));
});
it('reads the stored settings from the existing endpoint', async () => {
  const res = { json: vi.fn() };
  getSettings({ uid: 'u' } as any, res as any, vi.fn());
  await vi.waitFor(() => expect(res.json).toHaveBeenCalledWith({ id: 'u', ...state.data }));
});
