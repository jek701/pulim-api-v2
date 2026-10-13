import { describe, expect, it } from 'vitest';
import {
  inventory,
  type InventorySource,
  type RawDocument,
} from '../../scripts/migration/inventory';

const root = 'projects/test/databases/(default)/documents';
const timestamp = { seconds: '1700000000', nanos: 123456789 };

function fixture(
  collections: Record<string, string[]>,
  docs: Record<string, RawDocument[]>,
): InventorySource {
  return {
    async *collectionIds(parent) {
      yield* collections[parent] ?? [];
    },
    async *documents(parent, collection) {
      yield* docs[`${parent}/${collection}`] ?? [];
    },
  };
}

describe('read-only Firestore inventory', () => {
  it('finds unknown subcollections below missing ancestors without disclosing document IDs or values', async () => {
    const parent = `${root}/profiles/private-uid`;
    const source = fixture(
      { [root]: ['profiles'], [parent]: ['legacy'] },
      {
        [`${root}/profiles`]: [{ name: parent }],
        [`${parent}/legacy`]: [
          {
            name: `${parent}/legacy/private-id`,
            createTime: timestamp,
            fields: { secret: { stringValue: 'private-value' } },
          },
        ],
      },
    );
    const report = await inventory(source, root);
    expect(report.documents).toBe(1);
    expect(report.missingAncestors).toBe(1);
    expect(report.collections['/profiles/*/legacy'].mapping).toBe('requires-review');
    expect(JSON.stringify(report)).not.toMatch(/private-uid|private-id|private-value/);
  });

  it('detects int64 and nonfinite values without decoding through JS numbers', async () => {
    const source = fixture(
      { [root]: ['cards'] },
      {
        [`${root}/cards`]: [
          {
            name: `${root}/cards/a`,
            updateTime: timestamp,
            fields: {
              balance: { integerValue: '9223372036854775807' },
              finite: { doubleValue: 0.1 },
              invalid: { doubleValue: Infinity },
              empty: { nullValue: 0 },
              flag: { booleanValue: false },
              nested: { mapValue: { fields: { 'a/b': { stringValue: 'сум' } } } },
              history: {
                arrayValue: {
                  values: [{ timestampValue: timestamp }, { bytesValue: new Uint8Array([1]) }],
                },
              },
            },
          },
        ],
      },
    );
    const { fields } = (await inventory(source, root)).collections['/cards'];
    expect(fields['/balance'].unsafeIntegers).toBe(1);
    expect(fields['/invalid'].nonFiniteDoubles).toBe(1);
    expect(fields['/empty'].types).toEqual({ nullValue: 1 });
    expect(fields['/flag'].types).toEqual({ booleanValue: 1 });
    expect(fields['/nested/a~1b'].maxStringBytes).toBe(6);
    expect(fields['/history/*'].types).toEqual({ timestampValue: 1, bytesValue: 1 });
  });

  it('counts empty existing documents, aggregates schema across parent IDs and preserves dotted field names', async () => {
    const source = fixture(
      {
        [root]: ['profiles'],
        [`${root}/profiles/a`]: ['extra'],
        [`${root}/profiles/b`]: ['extra'],
      },
      {
        [`${root}/profiles`]: ['a', 'b'].map((id) => ({
          name: `${root}/profiles/${id}`,
          createTime: timestamp,
        })),
        [`${root}/profiles/a/extra`]: [
          {
            name: `${root}/profiles/a/extra/c`,
            createTime: timestamp,
            fields: {
              'stats.seen': { integerValue: '1' },
              stats: { mapValue: { fields: { seen: { integerValue: '2' } } } },
            },
          },
        ],
        [`${root}/profiles/b/extra`]: [
          { name: `${root}/profiles/b/extra/d`, createTime: timestamp },
        ],
      },
    );
    const report = await inventory(source, root);
    expect(report.documents).toBe(4);
    expect(report.collections['/profiles/*/extra'].documents).toBe(2);
    expect(report.collections['/profiles/*/extra'].fields).toHaveProperty('/stats.seen');
    expect(report.collections['/profiles/*/extra'].fields).toHaveProperty('/stats/seen');
  });

  it('fails closed on a budget overrun or unexpected document path', async () => {
    const source = fixture(
      { [root]: ['profiles'] },
      {
        [`${root}/profiles`]: ['a', 'b'].map((id) => ({
          name: `${root}/profiles/${id}`,
          createTime: timestamp,
        })),
      },
    );
    await expect(inventory(source, root, 1)).rejects.toThrow('INVENTORY_LIMIT_REACHED');
    const wrongSource = fixture(
      { [root]: ['profiles'] },
      {
        [`${root}/profiles`]: [{ name: 'projects/wrong/databases/wrong/documents/profiles/a' }],
      },
    );
    await expect(inventory(wrongSource, root)).rejects.toThrow('INVALID_DOCUMENT_PATH');
  });
});
