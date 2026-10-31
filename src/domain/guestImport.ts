import { createHash } from 'node:crypto';
import { z } from 'zod';

import { DEFAULT_CATEGORIES, defaultCategoryId } from './defaultCategories';
import {
  cardCreateSchema,
  categoryCreateSchema,
  subcategoryCreateSchema,
  subscriptionCreateSchema,
  transactionCreateSchema,
} from './schemas';
import { AppError } from '../utils/AppError';

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.number().finite().nonnegative();
const stamp = { id, createdAt: timestamp };

/** Only personal, free guest data is importable. Identity and sharing fields are stripped. */
export const guestImportSchema = z
  .object({
    importId: z.string().uuid(),
    cards: z.array(cardCreateSchema.extend({ ...stamp, cardType: z.literal('debit') })).max(1),
    categories: z.array(categoryCreateSchema.extend(stamp)).max(DEFAULT_CATEGORIES.length),
    subcategories: z.array(subcategoryCreateSchema.extend(stamp)).max(200),
    transactions: z
      .array(
        transactionCreateSchema.extend({
          ...stamp,
          amount: z.number().finite().positive().max(1e15),
          source: z.enum(['transfer', 'return', 'subscription']).optional(),
          sourceLabel: z.string().max(1000).optional(),
          categoryName: z.string().max(1000).optional(),
          categoryIcon: z.string().max(100).optional(),
          categoryColor: z.string().max(100).optional(),
          origin: z.string().max(100).optional(),
          linkedTransactionId: id.optional(),
          returnedAmount: z.number().finite().nonnegative().optional(),
          toCardId: id.optional(),
          toAmount: z.number().finite().positive().optional(),
          toCurrency: cardCreateSchema.shape.currency.optional(),
        }),
      )
      .max(1000),
    subscriptions: z.array(subscriptionCreateSchema.extend(stamp)).max(2),
    settings: z.object({ cardOrder: z.array(id).max(1).optional() }).optional(),
  })
  .strict();

export type GuestImportPayload = z.infer<typeof guestImportSchema>;
export interface GuestImportResult {
  importId: string;
  imported: { cards: number; transactions: number; subscriptions: number };
  idMap: Record<string, string>;
}
export interface GuestImportRow {
  table: 'cards' | 'categories' | 'subcategories' | 'transactions' | 'subscriptions';
  id: string;
  data: Record<string, unknown>;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const guestImportMarkerId = (uid: string, importId: string) =>
  `guest_import_${hash(`${uid}:${importId}`)}`;
export const guestImportHash = (payload: GuestImportPayload) => hash(JSON.stringify(payload));

/** Snapshot inserts never replay money operations: each imported card keeps its final balance. */
export function planGuestImport(
  uid: string,
  payload: GuestImportPayload,
): { rows: GuestImportRow[]; result: GuestImportResult } {
  const ids = new Map<string, string>();
  const seen = new Set<string>();
  const mapId = (value: string) => {
    if (!value) return value;
    if (['__subscription__', '__income__', '__debts__'].includes(value)) {
      ids.set(value, value);
      return value;
    }
    const known = ids.get(value);
    if (known) return known;
    const mapped = `guest_${hash(`${uid}:${payload.importId}:${value}`).slice(0, 48)}`;
    ids.set(value, mapped);
    return mapped;
  };

  for (const category of payload.categories) {
    const canonical = DEFAULT_CATEGORIES.find(
      (cat) => category.id === defaultCategoryId('guest', cat.type, cat.name),
    );
    if (!canonical || canonical.type !== category.type)
      throw AppError.badRequest('Only starter guest categories can be imported.');
    ids.set(category.id, defaultCategoryId(uid, canonical.type, canonical.name));
  }
  // Deleted starter categories may still be referenced by historical transactions.
  for (const category of DEFAULT_CATEGORIES)
    ids.set(
      defaultCategoryId('guest', category.type, category.name),
      defaultCategoryId(uid, category.type, category.name),
    );

  const rows: GuestImportRow[] = [];
  for (const table of [
    'categories',
    'subcategories',
    'cards',
    'transactions',
    'subscriptions',
  ] as const) {
    for (const source of payload[table]) {
      if (seen.has(source.id)) throw AppError.badRequest('Duplicate guest record id.');
      seen.add(source.id);
      const { id: sourceId, ...fields } = source;
      const data: Record<string, unknown> = { ...fields, userId: uid };
      if (table === 'transactions' || table === 'cards') data.scope = 'personal';
      for (const field of [
        'categoryId',
        'subcategoryId',
        'cardId',
        'toCardId',
        'linkedTransactionId',
      ] as const) {
        const value = data[field];
        if (typeof value === 'string' && value) data[field] = mapId(value);
      }
      rows.push({ table, id: mapId(sourceId), data });
    }
  }
  return {
    rows,
    result: {
      importId: payload.importId,
      imported: {
        cards: payload.cards.length,
        transactions: payload.transactions.length,
        subscriptions: payload.subscriptions.length,
      },
      idMap: Object.fromEntries(ids),
    },
  };
}
