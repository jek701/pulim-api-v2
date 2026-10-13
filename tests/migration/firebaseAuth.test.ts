import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  auth: vi.fn(() => ({ verifyIdToken: vi.fn() })),
  firestore: vi.fn(() => {
    throw new Error('Auth must not initialize Firestore');
  }),
  applicationDefault: vi.fn(() => ({})),
}));

vi.mock('firebase-admin', () => ({
  default: {
    initializeApp: sdk.initializeApp,
    auth: sdk.auth,
    firestore: sdk.firestore,
    credential: { applicationDefault: sdk.applicationDefault },
  },
}));
vi.mock('../../src/config/env', () => ({ env: { FIREBASE_PROJECT_ID: 'local-test' } }));

describe('Firebase Auth storage boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  it('initializes Auth without constructing a Firestore client', async () => {
    const { auth } = await import('../../src/config/firebaseAuth');
    expect(auth).toHaveProperty('verifyIdToken');
    expect(sdk.initializeApp).toHaveBeenCalledWith({ credential: {}, projectId: 'local-test' });
    expect(sdk.firestore).not.toHaveBeenCalled();
  });
});
