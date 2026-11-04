import type { Category } from '../domain/types';
import { filterQuery, queryTable, readDocument } from '../db/documents';
import { learnCaptureTransaction } from './categories';
import { getIssuedMerchant, isCaptureStorageReady, receiptSiblings } from './repository';
import type { CaptureMetadata } from './types';

/** Category with the largest saved amount; ties go to the smaller id so the result is stable. */
export function dominantCategory(rows: Array<{ categoryId: string; amount: number; type: string }>): string | null {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.type === 'expense' && row.categoryId) totals.set(row.categoryId, (totals.get(row.categoryId) ?? 0) + row.amount);
  }
  return [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

/**
 * Post-commit learning. A TIN is learned only if this server issued it to this user (capture_issued),
 * for expenses only; a receipt split into several transactions votes once, with its dominant
 * category by amount. A photo's TIN only updates the user's own memory. Guests never get here:
 * capture metadata is dropped for anonymous users before the write.
 */
export async function learnCommittedCapture(uid: string, transactionId: string,
  input: { capture?: CaptureMetadata; categoryId?: string; type?: string }): Promise<void> {
  const capture = input.capture;
  if (input.type !== 'expense' || !capture?.merchantTin || !input.categoryId || !await isCaptureStorageReady()) return;
  const issued = await getIssuedMerchant(uid, capture.merchantTin);
  if (!issued) return;
  let categoryId = input.categoryId;
  if (capture.receiptKey) {
    const dominant = dominantCategory(await receiptSiblings(uid, capture.receiptKey));
    if (dominant) categoryId = dominant;
  }
  const snap = await readDocument(filterQuery(queryTable('categories'), 'userId', '==', uid));
  const categories = snap.rows.map(row => ({ ...row.data, id: row.id })) as Category[];
  await learnCaptureTransaction({
    uid, transactionId, categoryId, merchantTin: capture.merchantTin, categories,
    // The "user changed my suggestion" double vote only counts if it is the suggestion we issued.
    suggestedCategoryId: issued.suggestedCategoryId && capture.suggestedCategoryId === issued.suggestedCategoryId
      ? issued.suggestedCategoryId : undefined,
    // Soliq data fetched by the server or reported by the phone both feed the shared votes (a phone
    // report only counts through the consensus rule); only OCR text from a photo does not.
    shared: issued.source === 'soliq' || issued.source === 'device', ...(capture.receiptKey ? { receiptKey: capture.receiptKey } : {}),
  });
}
