import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { database } from '../db/database';
import { receiptText } from './privacy';

let readiness: Promise<boolean> | undefined;
let probedAt = 0;
let known = false;
const RETRY_MISSING_MS = 30_000;
/** A positive probe is cached until restart; a negative one is retried after 30 s so a transient
 * DB error at first use cannot leave the feature dark, while a missing rollout stays cheap. */
export function isCaptureStorageReady(): Promise<boolean> {
  if (!readiness || (!known && Date.now() - probedAt > RETRY_MISSING_MS)) {
    probedAt = Date.now();
    readiness = Promise.resolve().then(() => sql`SELECT version FROM schema_migrations WHERE version = '005_capture'`
      .execute(database())).then((result) => result.rows.length === 1).catch(() => false)
      .then((ready) => { known = ready; return ready; });
  }
  return readiness;
}

export async function getCaptureUsage(uid: string, month: string): Promise<number> {
  const result = await sql<{ count: number }>`SELECT count FROM capture_usage WHERE uid = ${uid} AND month = ${month}`.execute(database());
  return Number(result.rows[0]?.count ?? 0);
}

const isDeadlock = (error: unknown): boolean => {
  const { errno, code } = (error ?? {}) as { errno?: unknown; code?: unknown };
  return errno === 1213 || code === 'ER_LOCK_DEADLOCK';
};
/** Two or three concurrent first-time inserts of one key can still deadlock in InnoDB: just retry. */
async function retryOnDeadlock<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); }
    catch (error) { if (attempt >= attempts || !isDeadlock(error)) throw error; }
  }
}

/**
 * Take one slot of a counter if it is below `limit`. The row lock is taken EXCLUSIVELY by the first
 * statement (INSERT ... ON DUPLICATE KEY UPDATE with a no-op update), never as the shared lock an
 * INSERT IGNORE takes on an existing row, so two double-tap requests cannot deadlock by both
 * upgrading shared -> exclusive. The conditional UPDATE then decides; its matched-row count is
 * unambiguous (the mysql2 driver reports matched, not changed, rows).
 */
export async function reserveCaptureUsage(uid: string, month: string, limit: number): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return false;
  return retryOnDeadlock(() => database().transaction().execute(async (db) => {
    await sql`INSERT INTO capture_usage (uid, month, count) VALUES (${uid}, ${month}, 0)
      ON DUPLICATE KEY UPDATE count = count`.execute(db);
    const result = await sql`UPDATE capture_usage SET count = count + 1
      WHERE uid = ${uid} AND month = ${month} AND count < ${limit}`.execute(db);
    return Number(result.numAffectedRows) === 1;
  }));
}

/** `count` is INT UNSIGNED: never GREATEST(count - 1, 0), which raises below zero. */
export async function refundCaptureUsage(uid: string, month: string): Promise<void> {
  await sql`UPDATE capture_usage SET count = IF(count > 0, count - 1, 0)
    WHERE uid = ${uid} AND month = ${month}`.execute(database());
}

/**
 * Refunds for results the user caused (nothing recognised, not a receipt) are limited per day, or a
 * free user could probe the recognition models indefinitely. True when this refund is allowed.
 */
export async function takeCaptureRefund(uid: string, day: string, cap: number): Promise<boolean> {
  return retryOnDeadlock(() => database().transaction().execute(async (db) => {
    await sql`INSERT INTO capture_refunds (uid, day, count) VALUES (${uid}, ${day}, 0)
      ON DUPLICATE KEY UPDATE count = count`.execute(db);
    const result = await sql`UPDATE capture_refunds SET count = count + 1
      WHERE uid = ${uid} AND day = ${day} AND count < ${cap}`.execute(db);
    return Number(result.numAffectedRows) === 1;
  }));
}

export async function findReceiptDuplicate(uid: string, receiptKey: string): Promise<{ date: string; transactionId: string } | undefined> {
  if (!await isCaptureStorageReady()) return undefined;
  const result = await sql<{ id: Buffer | string; data_json: unknown }>`SELECT id, data_json FROM transactions
    WHERE user_id = ${uid} AND capture_receipt_key = ${receiptKey} ORDER BY date_ms DESC LIMIT 1`.execute(database());
  const row = result.rows[0];
  if (!row) return undefined;
  const data = typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json as Record<string, unknown>;
  const date = new Date(data.date as string | number);
  if (!Number.isFinite(date.getTime())) return undefined;
  return { date: date.toISOString(), transactionId: Buffer.isBuffer(row.id) ? row.id.toString('utf8') : row.id };
}

const text = (value: unknown, max = 500): string | null => typeof value === 'string'
  ? receiptText(value).slice(0, max) : null;
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
/** Explicit allowlist: provider objects, buyer metadata, phone/card numbers can never enter cache. */
export function safeCachedReceipt(value: unknown): Record<string, unknown> {
  const receipt = value && typeof value === 'object' ? value as Record<string, any> : {};
  const merchant = receipt.merchant && typeof receipt.merchant === 'object' ? receipt.merchant : {};
  return {
    kind: receipt.kind === 'photo' ? 'photo' : 'soliq',
    receiptKey: typeof receipt.receiptKey === 'string' && /^[a-f0-9]{64}$/.test(receipt.receiptKey) ? receipt.receiptKey : '',
    merchant: {
      tin: typeof merchant.tin === 'string' && /^(?:\d{9}|\d{14})$/.test(merchant.tin) ? merchant.tin : null,
      name: text(merchant.name, 255), address: text(merchant.address),
    },
    date: typeof receipt.date === 'string' && Number.isFinite(Date.parse(receipt.date)) ? receipt.date : '',
    total: number(receipt.total),
    ...(receipt.cardTotal !== undefined ? { cardTotal: number(receipt.cardTotal) } : {}),
    ...(receipt.cashTotal !== undefined ? { cashTotal: number(receipt.cashTotal) } : {}),
    ...(receipt.isRefund === true ? { isRefund: true } : {}),
    items: Array.isArray(receipt.items) ? receipt.items.slice(0, 200).map((item: any) => ({
      name: text(item?.name, 255) ?? '', quantity: number(item?.quantity), price: number(item?.price),
      discount: number(item?.discount), amount: number(item?.amount),
      ...(typeof item?.ikpu === 'string' && /^\d{1,17}$/.test(item.ikpu) ? { ikpu: item.ikpu } : {}),
      categoryId: null,
    })) : [],
  };
}

export type ReceiptSource = 'server' | 'device';
/** Device-reported receipts live under their own key: a server fetch never reads (or trusts) them. */
const cacheKeyFor = (receiptKey: string, source: ReceiptSource): string =>
  source === 'device' ? createHash('sha256').update(`device:${receiptKey}`).digest('hex') : receiptKey;

/** Reads only an entry of the requested source. Entries from before the source existed were all server fetches. */
export async function getCachedReceipt<T>(receiptKey: string, source: ReceiptSource = 'server'): Promise<T | undefined> {
  const result = await sql<{ receipt_json: unknown }>`SELECT receipt_json FROM capture_receipt_cache
    WHERE receipt_key = ${cacheKeyFor(receiptKey, source)} AND expires_at > ${Date.now()}`.execute(database());
  if (!result.rows[0]) return undefined;
  const value = result.rows[0].receipt_json;
  const stored = (typeof value === 'string' ? JSON.parse(value) : value) as { receiptSource?: unknown } | null;
  if ((stored?.receiptSource ?? 'server') !== source) return undefined;
  return safeCachedReceipt(stored) as T;
}

export async function cacheReceipt(receiptKey: string, receipt: unknown, source: ReceiptSource = 'server'): Promise<void> {
  const safe = JSON.stringify({ ...safeCachedReceipt(receipt), receiptSource: source });
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await sql`INSERT INTO capture_receipt_cache (receipt_key, receipt_json, expires_at)
    VALUES (${cacheKeyFor(receiptKey, source)}, ${safe}, ${expires}) ON DUPLICATE KEY UPDATE
    receipt_json = VALUES(receipt_json), expires_at = VALUES(expires_at)`.execute(database());
  // Bounded housekeeping; cache lifetime does not depend on an optional worker.
  await sql`DELETE FROM capture_receipt_cache WHERE expires_at <= ${Date.now()} LIMIT 100`.execute(database());
}

export async function getCaptureMerchantNames(tins: string[]): Promise<string[]> {
  const valid = [...new Set(tins.filter((tin) => /^(?:\d{9}|\d{14})$/.test(tin)))].slice(0, 50);
  if (!valid.length) return [];
  const result = await sql<{ name: string | null }>`SELECT name FROM merchants WHERE tin IN (${sql.join(valid)})`.execute(database());
  return result.rows.map((row) => row.name).filter((name): name is string => Boolean(name));
}

export const ISSUED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** soliq = fetched by the server, device = Soliq data reported by the phone, photo = OCR text. */
export interface IssuedMerchant { source: 'soliq' | 'device' | 'photo'; suggestedCategoryId: string | null; draftId: string }

/** Remember what this server suggested to this user for a merchant (see capture_issued). */
export async function recordIssuedMerchant(uid: string, tin: string, issued: IssuedMerchant): Promise<void> {
  if (!/^(?:\d{9}|\d{14})$/.test(tin)) return;
  const now = Date.now();
  await sql`INSERT INTO capture_issued (uid, tin, source, suggested_category_id, draft_id, issued_at)
    VALUES (${uid}, ${tin}, ${issued.source}, ${issued.suggestedCategoryId}, ${issued.draftId.slice(0, 128)}, ${now})
    ON DUPLICATE KEY UPDATE source = VALUES(source), suggested_category_id = VALUES(suggested_category_id),
    draft_id = VALUES(draft_id), issued_at = VALUES(issued_at)`.execute(database());
  await sql`DELETE FROM capture_issued WHERE issued_at < ${now - ISSUED_TTL_MS} LIMIT 100`.execute(database());
}

export async function getIssuedMerchant(uid: string, tin: string): Promise<IssuedMerchant | undefined> {
  const result = await sql<{ source: string; suggested_category_id: Buffer | string | null; draft_id: string }>`SELECT source, suggested_category_id, draft_id
    FROM capture_issued WHERE uid = ${uid} AND tin = ${tin} AND issued_at > ${Date.now() - ISSUED_TTL_MS}`.execute(database());
  const row = result.rows[0];
  if (!row || !['soliq', 'device', 'photo'].includes(row.source)) return undefined;
  return { source: row.source as IssuedMerchant['source'], draftId: row.draft_id,
    suggestedCategoryId: row.suggested_category_id === null ? null : row.suggested_category_id.toString() };
}

/** The user's saved transactions that carry this receiptKey (split drafts share it). */
export async function receiptSiblings(uid: string, receiptKey: string): Promise<Array<{ categoryId: string; amount: number; type: string }>> {
  const result = await sql<{ data_json: unknown }>`SELECT data_json FROM transactions
    WHERE user_id = ${uid} AND capture_receipt_key = ${receiptKey} LIMIT 200`.execute(database());
  return result.rows.flatMap((row) => {
    const data = (typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json) as Record<string, unknown>;
    return typeof data.categoryId === 'string' && typeof data.amount === 'number'
      ? [{ categoryId: data.categoryId, amount: data.amount, type: String(data.type) }] : [];
  });
}
