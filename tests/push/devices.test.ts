import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  profiles: new Map<string, any>(),
  error: undefined as undefined | { code: string },
  transactionExecutors: [] as unknown[],
  flushExecutors: [] as unknown[],
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
        return op === 'is' ? row[key] === value : row[key] === value;
      });
    const chain: any = {
      selectAll: () => chain,
      select: (column: string) => {
        selected = column;
        return chain;
      },
      distinct: () => chain,
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
          store.transactionExecutors.push(db);
          return work(db);
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
    async read(ref: any) {
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
});
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
});
