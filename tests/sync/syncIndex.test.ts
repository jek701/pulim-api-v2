import { afterEach, describe, expect, it } from 'vitest';
import { collectionOf, keyHash, syncEpoch, syncScopeOf } from '../../src/db/syncIndex';
import { decodeCursor, encodeCursor } from '../../src/services/sync.service';
import { AppError } from '../../src/utils/AppError';

describe('syncScopeOf', () => {
  it('puts personal documents in the owner feed', () => {
    expect(syncScopeOf('cards', 'c1', { userId: 'u1' })).toBe('u:u1');
    expect(syncScopeOf('transactions', 't1', { userId: 'u1', scope: 'household' })).toBe('u:u1');
    expect(syncScopeOf('planned_expenses', 'p', { userId: 'u9' })).toBe('u:u9');
  });
  it('keys profile and settings by document id', () => {
    expect(syncScopeOf('profiles', 'tg_5', { isPremium: false })).toBe('u:tg_5');
    expect(syncScopeOf('userSettings', 'u1', {})).toBe('u:u1');
  });
  it('ignores household-owned, ownerless and non-synced documents', () => {
    expect(syncScopeOf('cards', 'c', { userId: 'household:h1' })).toBeNull();
    expect(syncScopeOf('cards', 'c', {})).toBeNull();
    expect(syncScopeOf('cards', 'c', undefined)).toBeNull();
    expect(syncScopeOf('aiChats', 'a', { userId: 'u1' })).toBeNull();
    expect(syncScopeOf('telegramOperations', 'a', { userId: 'u1' })).toBeNull();
    expect(syncScopeOf('idempotencyKeys', 'a', { userId: 'u1' })).toBeNull();
  });
  it('maps entities to API collection names', () => {
    expect(collectionOf('savingsGoals')).toBe('savingsGoals');
    expect(collectionOf('planned_expenses')).toBe('plannedExpenses');
    expect(collectionOf('profiles')).toBe('profile');
    expect(collectionOf('userSettings')).toBe('settings');
    expect(collectionOf('households')).toBeUndefined();
  });
  it('hashes entity and id without ambiguity', () => {
    expect(keyHash('cards', 'ab')).not.toEqual(keyHash('cardsa', 'b'));
    expect(keyHash('cards', 'ab')).toHaveLength(32);
  });
});

describe('sync cursors', () => {
  const original = process.env.SYNC_EPOCH;
  afterEach(() => {
    if (original === undefined) delete process.env.SYNC_EPOCH;
    else process.env.SYNC_EPOCH = original;
  });
  it('round-trips delta and snapshot cursors', () => {
    expect(decodeCursor(encodeCursor({ kind: 'delta', seq: 42 }))).toEqual({ kind: 'delta', seq: 42 });
    const snapshot = { kind: 'snapshot', head: 7, index: 3, after: 'abc-def' } as const;
    expect(decodeCursor(encodeCursor(snapshot))).toEqual(snapshot);
    expect(decodeCursor(encodeCursor({ ...snapshot, after: null }))).toMatchObject({ after: null });
  });
  it('rejects malformed cursors with 400 INVALID_CURSOR', () => {
    for (const bad of ['', 'x', 'd1.', 'd1.1.x', 'd1.-1.4', 's1.@@@', 's1.' + Buffer.from('[1,2]').toString('base64url'), 's1.' + Buffer.from(JSON.stringify([1, 1, 99, null])).toString('base64url'), 'd2.1.1']) {
      try {
        decodeCursor(bad);
        throw new Error(`accepted ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(400);
      }
    }
  });
  it('expires cursors from another epoch with 410', () => {
    const cursor = encodeCursor({ kind: 'delta', seq: 5 });
    process.env.SYNC_EPOCH = '2';
    expect(syncEpoch()).toBe(2);
    try {
      decodeCursor(cursor);
      throw new Error('accepted');
    } catch (error) {
      expect((error as AppError).statusCode).toBe(410);
    }
  });
});
