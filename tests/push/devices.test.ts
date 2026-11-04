import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  profiles: new Map<string, any>(),
  error: undefined as undefined | { code: string },
  transactionExecutors: [] as unknown[],
  flushExecutors: [] as unknown[],
  profileLocks: new Map<string, Promise<void>>(),
  lockedOwners: [] as string[],
  operations: [] as string[],
}));
vi.mock('../../src/db/database', () => {
  function query(kind: string) {
    let values: any;
    let duplicate: any;
    const filters: [string, string, any][] = [];
    let selected = '';
    let maximum = Infinity;
    const matches = (row: any) =>
      filters.every(([key, op, value]) => {
        if (Buffer.isBuffer(value))
          return op === '>'
            ? Buffer.compare(Buffer.from(row[key]), value) > 0
            : Buffer.from(row[key]).equals(value);
        return op === 'in' ? value.includes(row[key]) : row[key] === value;
      });
    const chain: any = {
      selectAll: () => chain,
      select: (column: string) => {
        selected = column;
        return chain;
      },
      distinct: () => chain,
      forUpdate: () => chain,
      orderBy: () => chain,
      limit: (value: number) => {
        maximum = value;
        return chain;
      },
      values: (input: any) => {
        values = input;
        return chain;
      },
      set: (input: any) => {
        values = input;
        return chain;
      },
      onDuplicateKeyUpdate: (input: any) => {
        duplicate = input;
        return chain;
      },
      where: (key: string, op: string, value: any) => {
        filters.push([key, op, value]);
        return chain;
      },
      execute: async () => {
        if (store.error) throw store.error;
        if (kind === 'insert') {
          store.operations.push('insert');
          const current = store.rows.get(values.token);
          store.rows.set(values.token, current ? { ...current, ...duplicate } : values);
        }
        if (kind === 'delete')
          for (const [token, row] of store.rows) if (matches(row)) store.rows.delete(token);
        if (kind === 'update')
          for (const [token, row] of store.rows)
            if (matches(row)) store.rows.set(token, { ...row, ...values });
        const rows = [...store.rows.values()].filter(matches);
        if (selected === 'uid')
          return [...new Set(rows.map((row) => row.uid.toString()))]
            .sort()
            .slice(0, maximum)
            .map((uid) => ({ uid: Buffer.from(uid) }));
        return rows;
      },
      executeTakeFirstOrThrow: async () => (await chain.execute())[0],
    };
    return chain;
  }
  const db: any = {
    selectFrom: () => query('select'),
    insertInto: () => query('insert'),
    deleteFrom: () => query('delete'),
    updateTable: () => query('update'),
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async (work: any) => {
          const executor = { ...db, releases: [] as Array<() => void> };
          store.transactionExecutors.push(executor);
          try { return await work(executor); }
          finally { executor.releases.forEach(release => release()); }
        },
      }),
    }),
  };
  return { database: () => db };
});
vi.mock('../../src/repositories/profile.repository', () => ({
  profileRef: (uid: string) => ({ id: uid }),
}));
vi.mock('../../src/notifications/settings', () => ({
  notificationDefaults: () => ({ enabled: true }),
}));
vi.mock('../../src/db/documents', () => ({
  SqlTransaction: class {
    writes: any[] = [];
    constructor(private executor: any) {}
    async read(ref: any) {
      const previous = store.profileLocks.get(ref.id) ?? Promise.resolve();
      let release!: () => void;
      const lock = new Promise<void>(resolve => { release = resolve; });
      store.profileLocks.set(ref.id, lock);
      await previous;
      this.executor.releases.push(release);
      store.lockedOwners.push(ref.id);
      store.operations.push('profile_lock');
      return { exists: store.profiles.has(ref.id), data: store.profiles.get(ref.id) };
    }
    save(ref: any, data: any) {
      this.writes.push({ ref, data });
    }
    async flush(executor: unknown) {
      store.flushExecutors.push(executor);
      for (const { ref, data } of this.writes)
        store.profiles.set(ref.id, { ...store.profiles.get(ref.id), ...data });
    }
  },
}));
import {
  disableDevice,
  enabledDevices,
  listPushUserIds,
  pushActive,
  registerDevice,
  unregisterDevice,
} from '../../src/push/devices.repository';
import { registerDeviceSchema } from '../../src/push/schemas';
const registration = registerDeviceSchema.parse({
  token: 'AB'.repeat(32),
  platform: 'ios',
  environment: 'sandbox',
  bundleId: 'com.izik.pulim',
  appVersion: '1.0',
  buildNumber: '10',
  language: 'uz',
  timezone: 'Asia/Tashkent',
});
beforeEach(() => {
  store.rows.clear();
  store.profiles.clear();
  store.error = undefined;
  store.transactionExecutors.length = 0;
  store.flushExecutors.length = 0;
  store.profileLocks.clear();
  store.lockedOwners.length = 0;
  store.operations.length = 0;
});
afterEach(() => vi.restoreAllMocks());
describe('push device ownership', () => {
  it('upserts one normalized token, preserves creation and atomically updates profile metadata', async () => {
    const first = await registerDevice('one', registration);
    const next = await registerDevice('one', {
      ...registration,
      appVersion: '1.1',
      language: 'ru',
      timezone: 'Europe/London',
    });
    expect(next.id).toBe(first.id);
    expect(next.createdAt).toBe(first.createdAt);
    expect(next.appVersion).toBe('1.1');
    expect(store.rows.size).toBe(1);
    expect(store.profiles.get('one')).toMatchObject({
      language: 'ru',
      timezone: 'Europe/London',
      notifications: { timezone: 'Europe/London' },
    });
    expect(store.flushExecutors).toEqual(store.transactionExecutors);
    expect(await pushActive('one')).toBe(true);
  });
  it('moves the token between accounts and reenables disabled devices', async () => {
    const first = await registerDevice('one', registration);
    await disableDevice(first.id, 'Unregistered');
    expect(await pushActive('one')).toBe(false);
    const moved = await registerDevice('two', { ...registration, environment: 'production' });
    expect(moved).toMatchObject({
      id: first.id,
      uid: 'two',
      environment: 'production',
      disabledAt: null,
      disabledReason: null,
    });
    expect(await enabledDevices('one')).toEqual([]);
    expect(await enabledDevices('two')).toHaveLength(1);
    await unregisterDevice('one', registration.token);
    expect(await pushActive('two')).toBe(true);
    await unregisterDevice('two', registration.token.toUpperCase());
    await unregisterDevice('two', registration.token);
    expect(await pushActive('two')).toBe(false);
  });
  it('ignores a stale disabling response after a newer registration', async () => {
    const first = await registerDevice('one', registration);
    await disableDevice(first.id, 'BadDeviceToken', first.lastSeenAt - 1);
    expect(await pushActive('one')).toBe(true);
    await disableDevice(first.id, 'BadDeviceToken', first.lastSeenAt);
    expect(await pushActive('one')).toBe(false);
  });
  it('pages distinct enabled owners independently of their Telegram profile', async () => {
    await registerDevice('z', registration);
    await registerDevice('a', { ...registration, token: 'cd'.repeat(32) });
    await registerDevice('a', { ...registration, token: 'ef'.repeat(32) });
    const disabled = await registerDevice('m', { ...registration, token: 'aa'.repeat(32) });
    await disableDevice(disabled.id, 'Unregistered');
    expect(await listPushUserIds(undefined, 1)).toEqual(['a']);
    expect(await listPushUserIds('a', 1)).toEqual(['z']);
    expect(await listPushUserIds('z')).toEqual([]);
  });
  it('falls back before the additive migration, but does not hide outages', async () => {
    store.error = { code: 'ER_NO_SUCH_TABLE' };
    expect(await enabledDevices('one')).toEqual([]);
    expect(await listPushUserIds()).toEqual([]);
    expect(await pushActive('one')).toBe(false);
    await expect(unregisterDevice('one', registration.token)).resolves.toBeUndefined();
    store.error = { code: 'ECONNRESET' };
    await expect(pushActive('one')).rejects.toMatchObject({ code: 'ECONNRESET' });
  });
  it('returns a clear unavailable error when registering before the migration', async () => {
    store.error = { code: 'ER_NO_SUCH_TABLE' };
    await expect(registerDevice('one', registration)).rejects.toMatchObject({ statusCode: 503, code: 'PUSH_UNAVAILABLE' });
  });
  it('keeps at most ten devices and retires the least recently seen one', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const inputs = Array.from({ length: 11 }, (_, index) => ({
      ...registration, token: index.toString(16).padStart(64, '0'),
    }));
    for (const input of inputs.slice(0, 10)) await registerDevice('one', input);
    // Refreshing the first device makes the second device the oldest.
    await registerDevice('one', inputs[0]);
    await registerDevice('one', inputs[10]);
    expect(await enabledDevices('one')).toHaveLength(10);
    expect(store.rows.get(inputs[1].token)).toMatchObject({ disabled_reason: 'DeviceLimitExceeded' });
    expect(store.rows.get(inputs[0].token).disabled_at).toBeNull();
    expect(store.rows.get(inputs[10].token).disabled_at).toBeNull();
  });
  it('serializes simultaneous registrations by owner before enforcing the cap', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const inputs = Array.from({ length: 12 }, (_, index) => ({
      ...registration, token: index.toString(16).padStart(64, '0'),
    }));
    await Promise.all(inputs.map(input => registerDevice('one', input)));
    expect(store.lockedOwners).toEqual(Array(12).fill('one'));
    expect(store.operations).toEqual(Array.from({ length: 12 }, () => ['profile_lock', 'insert']).flat());
    expect(await enabledDevices('one')).toHaveLength(10);
    expect(inputs.slice(0, 2).map(input => store.rows.get(input.token).disabled_reason))
      .toEqual(['DeviceLimitExceeded', 'DeviceLimitExceeded']);
    expect(store.flushExecutors).toEqual(store.transactionExecutors);
  });
});
