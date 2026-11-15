import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getUser: vi.fn(),
  readDocument: vi.fn(),
}));
vi.mock('../../src/config/firebaseAuth', () => ({ auth: state }));
vi.mock('../../src/db/documents', () => ({
  documentKey: (_table: string, id: string) => ({ id }),
  readDocument: state.readDocument,
}));
import { authenticate } from '../../src/middleware/authenticate';

const call = (path: string, authorization = 'Bearer synthetic') =>
  new Promise<any>((resolve) => {
    authenticate({ method: 'POST', path, headers: { authorization } } as any, {} as any, (error) =>
      resolve(error),
    );
  });
beforeEach(() => {
  vi.resetAllMocks();
  state.verifyIdToken.mockResolvedValue({ uid: 'synthetic', auth_time: 100 });
  state.getUser.mockResolvedValue({ metadata: { creationTime: new Date(0).toISOString() } });
  state.readDocument.mockResolvedValue({ exists: false });
});

describe('authentication during account deletion', () => {
  it('keeps the deletion route authenticated', async () => {
    expect(await call('/account/delete', '')).toMatchObject({ statusCode: 401 });
    expect(state.verifyIdToken).not.toHaveBeenCalled();
  });
  it('checks revocation for bootstrap and permits a revoked-token deletion retry', async () => {
    state.verifyIdToken.mockImplementation(async (_token, checkRevoked) => {
      if (checkRevoked) throw { code: 'auth/id-token-revoked' };
      return { uid: 'synthetic', auth_time: 100 };
    });
    expect(await call('/profile/bootstrap')).toMatchObject({ code: 'auth/id-token-revoked' });
    expect(await call('/account/delete')).toBeUndefined();
    expect(state.verifyIdToken).toHaveBeenLastCalledWith('synthetic', false);
  });
  it('prevents a stale token from deleting a newly created Firebase account with the same uid', async () => {
    state.getUser.mockResolvedValue({
      metadata: { creationTime: new Date(200_000).toISOString() },
    });
    expect(await call('/account/delete')).toMatchObject({ statusCode: 401 });
  });
  it('preserves first sign-in capabilities and ordinary token verification without revocation', async () => {
    expect(await call('/sync/capabilities')).toBeUndefined();
    expect(state.verifyIdToken).toHaveBeenCalledWith('synthetic', false);
    state.readDocument.mockResolvedValue({ exists: true, data: { deletionRequestedAt: 1 } });
    expect(await call('/sync/capabilities')).toMatchObject({ statusCode: 409 });
  });
  it('maps bootstrap Firebase outages to 503 rather than invalid credentials', async () => {
    state.verifyIdToken.mockRejectedValue({ code: 'auth/internal-error' });
    expect(await call('/profile/bootstrap')).toMatchObject({
      statusCode: 503,
      code: 'AUTH_UNAVAILABLE',
    });
  });
  it('blocks bootstrap while deletion is marked and allows fresh bootstrap after removal', async () => {
    state.readDocument.mockResolvedValueOnce({ exists: true, data: { deletionRequestedAt: 1 } });
    expect(await call('/profile/bootstrap')).toMatchObject({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    expect(await call('/profile/bootstrap')).toBeUndefined();
  });
});
