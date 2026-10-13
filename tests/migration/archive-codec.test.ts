import { describe, expect, it } from 'vitest';
import {
  archiveFields,
  hash,
  rawFields,
  runtimeDocument,
  typedFields,
} from '../../scripts/migration/archive-codec';
import { decodeData, encodeData } from '../../src/db/values';

describe('Firestore typed archive', () => {
  it('round-trips integer/double distinctions, nanoseconds and opaque types through SQL encoding', () => {
    const source = archiveFields({
      int: { integerValue: '1' },
      double: { doubleValue: 1 },
      big: { integerValue: '9223372036854775807' },
      timestamp: { timestampValue: { seconds: '123', nanos: 987654321 } },
      bytes: { bytesValue: Buffer.from([0, 128, 255]) },
      reference: { referenceValue: 'projects/p/databases/d/documents/c/a' },
      nested: {
        mapValue: {
          fields: { empty: { mapValue: {} }, nil: { nullValue: 0 }, flag: { booleanValue: false } },
        },
      },
      array: {
        arrayValue: {
          values: [{ doubleValue: -0 }, { doubleValue: NaN }, { doubleValue: Infinity }],
        },
      },
    });
    const document = { path: 'profiles/a', fields: source };
    const encoded = encodeData(runtimeDocument(document));
    const reconstructed = typedFields(decodeData(encoded.data_json, encoded.types_json), source);
    expect(hash(reconstructed)).toBe(hash(source));
    expect(archiveFields(rawFields(reconstructed))).toEqual(source);
  });
  it('canonical hashes ignore map key order while retaining array order and missing/null', () => {
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash([1, 2])).not.toBe(hash([2, 1]));
    expect(hash({ absent: null })).not.toBe(hash({}));
  });
});
