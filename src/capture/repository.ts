import { sql } from 'kysely';
import { database } from '../db/database';
import { receiptText } from './privacy';

let readiness: Promise<boolean> | undefined;
/** A missing rollout is cached until restart, matching the device-registry readiness pattern. */
export function isCaptureStorageReady(): Promise<boolean> {
  return readiness ??= Promise.resolve().then(() => sql`SELECT version FROM schema_migrations WHERE version = '005_capture'`
    .execute(database())).then((result) => result.rows.length === 1).catch(() => false);
}

export async function getCaptureUsage(uid: string, month: string): Promise<number> {
  const result = await sql<{ count: number }>`SELECT count FROM capture_usage WHERE uid = ${uid} AND month = ${month}`.execute(database());
  return Number(result.rows[0]?.count ?? 0);
}

export async function reserveCaptureUsage(uid: string, month: string, limit: number): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return false;
  return database().transaction().execute(async (db) => {
    await sql`INSERT IGNORE INTO capture_usage (uid, month, count) VALUES (${uid}, ${month}, 0)`.execute(db);
    const result = await sql`UPDATE capture_usage SET count = count + 1
      WHERE uid = ${uid} AND month = ${month} AND count < ${limit}`.execute(db);
    return Number(result.numAffectedRows) === 1;
  });
}

export async function refundCaptureUsage(uid: string, month: string): Promise<void> {
  await sql`UPDATE capture_usage SET count = GREATEST(count - 1, 0)
    WHERE uid = ${uid} AND month = ${month}`.execute(database());
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
    items: Array.isArray(receipt.items) ? receipt.items.slice(0, 200).map((item: any) => ({
      name: text(item?.name, 255) ?? '', quantity: number(item?.quantity), price: number(item?.price),
      discount: number(item?.discount), amount: number(item?.amount),
      ...(typeof item?.ikpu === 'string' && /^\d{1,17}$/.test(item.ikpu) ? { ikpu: item.ikpu } : {}),
      categoryId: null,
    })) : [],
  };
}

export async function getCachedReceipt<T>(receiptKey: string): Promise<T | undefined> {
  const result = await sql<{ receipt_json: unknown }>`SELECT receipt_json FROM capture_receipt_cache
    WHERE receipt_key = ${receiptKey} AND expires_at > ${Date.now()}`.execute(database());
  if (!result.rows[0]) return undefined;
  const value = result.rows[0].receipt_json;
  return safeCachedReceipt(typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export async function cacheReceipt(receiptKey: string, receipt: unknown): Promise<void> {
  const safe = JSON.stringify(safeCachedReceipt(receipt));
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await sql`INSERT INTO capture_receipt_cache (receipt_key, receipt_json, expires_at)
    VALUES (${receiptKey}, ${safe}, ${expires}) ON DUPLICATE KEY UPDATE
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
