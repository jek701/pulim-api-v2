import type { Category } from '../domain/types';
import { filterQuery, queryTable, readDocument } from '../db/documents';
import { learnCaptureTransaction } from './categories';
import { isCaptureStorageReady } from './repository';
import type { CaptureMetadata } from './types';

export async function learnCommittedCapture(uid: string, transactionId: string,
  input: { capture?: CaptureMetadata; categoryId?: string }): Promise<void> {
  const capture = input.capture;
  if (!capture?.merchantTin || !input.categoryId || !await isCaptureStorageReady()) return;
  const snap = await readDocument(filterQuery(queryTable('categories'), 'userId', '==', uid));
  const categories = snap.rows.map(row => ({ ...row.data, id: row.id })) as Category[];
  await learnCaptureTransaction({
    uid, transactionId, categoryId: input.categoryId, merchantTin: capture.merchantTin,
    suggestedCategoryId: capture.suggestedCategoryId, categories,
  });
}
