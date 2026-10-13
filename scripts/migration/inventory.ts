/** Pure, read-only inventory logic. No runtime app configuration or writers. */
export interface RawValue {
  nullValue?: unknown;
  booleanValue?: boolean | null;
  integerValue?: number | string | { toString(): string } | null;
  doubleValue?: number | null;
  timestampValue?: unknown;
  stringValue?: string | null;
  bytesValue?: unknown;
  referenceValue?: string | null;
  geoPointValue?: unknown;
  arrayValue?: { values?: RawValue[] | null } | null;
  mapValue?: { fields?: Record<string, RawValue> | null } | null;
}

export interface RawDocument {
  name?: string | null;
  fields?: Record<string, RawValue> | null;
  createTime?: unknown;
  updateTime?: unknown;
}

export interface InventorySource {
  collectionIds(parent: string): AsyncIterable<string>;
  documents(parent: string, collectionId: string): AsyncIterable<RawDocument>;
}

interface FieldStats {
  occurrences: number;
  types: Record<string, number>;
  unsafeIntegers: number;
  nonFiniteDoubles: number;
  maxStringBytes: number;
}

interface CollectionStats {
  documents: number;
  missingAncestors: number;
  maxIdBytes: number;
  mapping: 'known-root' | 'requires-review';
  fields: Record<string, FieldStats>;
}

export const knownCollections = new Set([
  'profiles',
  'userSettings',
  'categories',
  'subcategories',
  'cards',
  'transactions',
  'budgets',
  'savingsGoals',
  'debts',
  'deposits',
  'subscriptions',
  'planned_expenses',
  'households',
  'householdInvites',
  'householdInvitePicks',
  'telegramUsers',
  'phoneVerifications',
  'shortcutTokens',
  'billingEvents',
  'aiChats',
  'aiUsage',
  'aiFeedback',
  'aiForecastCache',
  'fxRates',
  'telegramUpdates',
  'telegramOperations',
  'telegramDrafts',
  'telegramSessions',
  'telegramMessages',
  'telegramUsage',
  'notifications',
  'notificationTasks',
  'notificationState',
  'notificationStats',
  'communicationCampaigns',
  'inAppMessages',
  'communicationDeliveries',
  'devNotes',
  'devNoteScreenshots',
]);

const valueKinds = [
  'nullValue',
  'booleanValue',
  'integerValue',
  'doubleValue',
  'timestampValue',
  'stringValue',
  'bytesValue',
  'referenceValue',
  'geoPointValue',
  'arrayValue',
  'mapValue',
] as const;

function inspectValue(fields: Record<string, FieldStats>, path: string, value: RawValue): void {
  const stats = (fields[path] ??= {
    occurrences: 0,
    types: Object.create(null),
    unsafeIntegers: 0,
    nonFiniteDoubles: 0,
    maxStringBytes: 0,
  });
  stats.occurrences++;
  const present = valueKinds.filter((kind) => Object.hasOwn(value, kind) && value[kind] != null);
  const kind = present.length === 1 ? present[0] : 'unsupported';
  stats.types[kind] = (stats.types[kind] ?? 0) + 1;
  if (kind === 'integerValue') {
    // Do not decode int64 through Number: the precision may already be lost.
    const integer = value.integerValue!;
    if (typeof integer === 'number' && !Number.isSafeInteger(integer)) {
      stats.unsafeIntegers++;
    } else {
      const exact = BigInt(integer.toString());
      if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) {
        stats.unsafeIntegers++;
      }
    }
  }
  if (kind === 'doubleValue' && !Number.isFinite(value.doubleValue)) stats.nonFiniteDoubles++;
  if (kind === 'stringValue')
    stats.maxStringBytes = Math.max(stats.maxStringBytes, Buffer.byteLength(value.stringValue!));
  if (kind === 'mapValue') inspectFields(fields, path, value.mapValue?.fields ?? {});
  if (kind === 'arrayValue') {
    for (const element of value.arrayValue?.values ?? [])
      inspectValue(fields, `${path}/*`, element);
  }
}

function inspectFields(
  stats: Record<string, FieldStats>,
  parent: string,
  fields: Record<string, RawValue>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    const escaped = name.replace(/~/g, '~0').replace(/\//g, '~1');
    inspectValue(stats, `${parent}/${escaped}`, value);
  }
}

export async function inventory(
  source: InventorySource,
  root: string,
  maxDocuments = 100_000,
  options: {
    onDocument?: (document: RawDocument) => Promise<void>;
    onProgress?: (count: number) => void;
  } = {},
) {
  const collections: Record<string, CollectionStats> = Object.create(null);
  let scannedPaths = 0;
  let documents = 0;
  let missingAncestors = 0;

  const queue = [{ parent: root, schemaPath: '' }];
  let pending = 1;
  let failure: unknown;
  const waiters: Array<() => void> = [];
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  async function take() {
    while (!failure) {
      if (queue.length) return queue.shift()!;
      if (pending === 0) return null;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    throw failure;
  }
  async function walk(parent: string, schemaPath: string): Promise<void> {
    for await (const collectionId of source.collectionIds(parent)) {
      const path = `${schemaPath}/${collectionId}`;
      const stats = (collections[path] ??= {
        documents: 0,
        missingAncestors: 0,
        maxIdBytes: 0,
        mapping:
          schemaPath === '' && knownCollections.has(collectionId)
            ? 'known-root'
            : 'requires-review',
        fields: Object.create(null),
      });
      const prefix = `${parent}/${collectionId}/`;
      for await (const document of source.documents(parent, collectionId)) {
        if (failure) throw failure;
        if (++scannedPaths % 100 === 0) options.onProgress?.(scannedPaths);
        if (scannedPaths > maxDocuments) throw new Error('INVENTORY_LIMIT_REACHED');
        const name = document.name;
        if (
          !name?.startsWith(prefix) ||
          !name.slice(prefix.length) ||
          name.slice(prefix.length).includes('/')
        ) {
          throw new Error('INVALID_DOCUMENT_PATH');
        }
        const missing = !document.createTime && !document.updateTime;
        if (missing) {
          stats.missingAncestors++;
          missingAncestors++;
        } else {
          stats.documents++;
          documents++;
          stats.maxIdBytes = Math.max(
            stats.maxIdBytes,
            Buffer.byteLength(name.slice(prefix.length)),
          );
          inspectFields(stats.fields, '', document.fields ?? {});
          await options.onDocument?.(document);
        }
        // showMissing is essential: subcollections can exist beneath deleted parents.
        queue.push({ parent: name, schemaPath: `${path}/*` });
        pending++;
        wake();
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      try {
        while (true) {
          const task = await take();
          if (!task) return;
          try {
            await walk(task.parent, task.schemaPath);
          } finally {
            pending--;
            wake();
          }
        }
      } catch (error) {
        failure ??= error;
        wake();
      }
    }),
  );
  if (failure) throw failure;
  return { documents, missingAncestors, scannedPaths, collections };
}
