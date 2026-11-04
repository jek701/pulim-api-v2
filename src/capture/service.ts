import { randomUUID } from 'node:crypto';
import { filterQuery, limitQuery, orderQuery, queryTable, readDocument } from '../db/documents';
import { getProfile } from '../repositories/profile.repository';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories';
import type { Category } from '../domain/types';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { STANDARD_CATEGORY_KEYS, inferCaptureCategory } from './categories';
import { cacheReceipt, findReceiptDuplicate, getCachedReceipt, getCaptureMerchantNames } from './repository';
import { SoliqClient, parseSoliqUrl } from './soliq';
import { extractCapturePhoto, guessCaptureCategory, parseCaptureVoice, transcribeCapture, type CaptureContext } from './models';
import { captureTimezone, dateInTimezone } from './time';
import { withCaptureQuota } from './quota';
import type { CaptureDraft, CaptureReceipt } from './types';

export async function captureContext(uid: string, timezone?: string): Promise<CaptureContext> {
  const owned = async (table: string) => {
    const snap = await readDocument(filterQuery(queryTable(table), 'userId', '==', uid));
    return snap.rows.map(row => ({ ...row.data, id: row.id }));
  };
  const [categories, accounts, recent, profile] = await Promise.all([
    owned('categories'), owned('cards'),
    readDocument(limitQuery(orderQuery(filterQuery(queryTable('transactions'), 'userId', '==', uid), 'date', 'desc'), 60)),
    getProfile(uid),
  ]);
  const zone = timezone ?? (profile as { timezone?: string } | null)?.timezone ?? 'Asia/Tashkent';
  const zoneParsed = captureTimezone.safeParse(zone);
  // Personal, user-categorised spending only (no household rows, transfers or other system operations).
  const history = recent.rows.map(row => row.data)
    .filter(row => row.scope !== 'household' && !row.source && row.categoryId && String(row.comment ?? '').trim())
    .slice(0, 30);
  const merchantNames = await getCaptureMerchantNames(history.flatMap(row =>
    typeof row.capture?.merchantTin === 'string' ? [row.capture.merchantTin] : []));
  const language = (profile as { language?: string } | null)?.language;
  return {
    language: language === 'ru' || language === 'en' || language === 'uz' ? language : 'uz',
    categories: categories as Category[],
    accounts: accounts.filter((a: any) => a.scope !== 'household').map((a: any) => ({
      id: a.id, name: String(a.name ?? ''), currency: String(a.currency ?? 'UZS'),
    })),
    recent: history.map(row => ({ comment: String(row.comment ?? '').slice(0, 500), categoryId: String(row.categoryId ?? '') })),
    merchantNames, timezone: zoneParsed.success ? zoneParsed.data : 'Asia/Tashkent', now: new Date(),
  };
}

export async function captureVoice(uid: string, buffer: Buffer, mime: string, timezone?: string, language?: 'uz' | 'ru' | 'en') {
  return withCaptureQuota(uid, true, async ({ release }) => {
    const context = await captureContext(uid, timezone);
    const transcript = await transcribeCapture(uid, buffer, mime, context, language);
    const drafts = transcript ? await parseCaptureVoice(uid, transcript, context) : [];
    // Silence or unrelated speech is not a recognition the user should pay a free-tier slot for.
    if (!drafts.length) release();
    return { transcript, drafts };
  });
}

const RECEIPT_WORD = { ru: 'Чек', uz: 'Chek', en: 'Receipt' } as const;
/** Server-written comment, e.g. "Korzinka · 5 позиций". Localized to the profile language. */
export function receiptComment(name: string | null, count: number, language: 'uz' | 'ru' | 'en' = 'uz'): string {
  let items = '';
  if (count > 0) {
    if (language === 'ru') {
      const word = count % 10 === 1 && count % 100 !== 11 ? 'позиция'
        : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'позиции' : 'позиций';
      items = `${count} ${word}`;
    } else items = language === 'uz' ? `${count} ta mahsulot` : `${count} ${count === 1 ? 'item' : 'items'}`;
  }
  return [name, items].filter(Boolean).join(' · ') || RECEIPT_WORD[language];
}

export async function receiptDrafts(uid: string, receipt: CaptureReceipt, context: CaptureContext,
  options: { currency?: string; amountLow?: boolean; dateLow?: boolean } = {}) {
  // Receipts are expenses: only expense standard keys may be guessed, only expense categories mapped.
  const expenseKeys = STANDARD_CATEGORY_KEYS.filter(key => DEFAULT_CATEGORIES.some(c =>
    c.type === 'expense' && c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') === key));
  const categories = context.categories.filter(c => c.type === 'expense' || c.type === 'both');
  const guess = () => guessCaptureCategory(uid, `${receipt.merchant.name ?? ''}; ${receipt.items.slice(0, 15).map(i => i.name).join(', ')}`, expenseKeys);
  const classifyIkpu = (prefix: string) => guessCaptureCategory(uid,
    `IKPU group ${prefix}: ${receipt.items.filter(i => i.ikpu?.startsWith(prefix)).slice(0, 10).map(i => i.name).join(', ')}`, expenseKeys);
  const inferred = await inferCaptureCategory({ uid, tin: receipt.merchant.tin ?? undefined,
    merchant: receipt.merchant, categories, items: receipt.items, aiGuess: guess, classifyIkpu });
  // Item-level inference omits the TIN so a broad merchant category cannot override IKPU.
  // One lookup per distinct IKPU code, not per line.
  const byIkpu = new Map<string, string | null>();
  for (const item of receipt.items) {
    let categoryId: string | null = null;
    if (item.ikpu) {
      if (!byIkpu.has(item.ikpu)) {
        byIkpu.set(item.ikpu, (await inferCaptureCategory({ uid, categories, items: [item], classifyIkpu })).categoryId);
      }
      categoryId = byIkpu.get(item.ikpu) ?? null;
    }
    item.categoryId = categoryId ?? inferred.categoryId;
  }
  // The account is not stated on a receipt: null lets the app pre-fill its default, not a doubt.
  const low: CaptureDraft['lowConfidenceFields'] = [];
  if (!inferred.categoryId || inferred.confidence === 'low') low.push('category');
  if (options.amountLow) low.push('amount');
  if (options.dateLow) low.push('date');
  const draft: CaptureDraft = {
    draftId: randomUUID(), type: 'expense', amount: receipt.total, currency: options.currency ?? 'UZS',
    categoryId: inferred.categoryId, categoryConfidence: inferred.categoryId ? inferred.confidence : 'low',
    accountId: null, date: dateInTimezone(new Date(receipt.date), context.timezone),
    comment: receiptComment(receipt.merchant.name, receipt.items.length, context.language),
    lowConfidenceFields: low, items: receipt.items,
  };
  const duplicateOf = await findReceiptDuplicate(uid, receipt.receiptKey);
  return { receipt, drafts: [draft], ...(duplicateOf ? { duplicateOf } : {}) };
}

export async function captureSoliq(uid: string, url: string, timezone?: string) {
  parseSoliqUrl(url); // A malformed URL is rejected before any quota or network work.
  return withCaptureQuota(uid, env.CAPTURE_COUNT_SOLIQ, async () => {
    const client = new SoliqClient({
      signingKey: env.SOLIQ_OFD_SIGNING_KEY, amountDivisor: env.SOLIQ_AMOUNT_DIVISOR,
      cache: {
        get: async key => {
          const receipt = await getCachedReceipt<CaptureReceipt>(key);
          return receipt ? { receipt: receipt as any, expiresAt: Date.now() + 60_000 } : null;
        },
        set: async (key, receipt) => { await cacheReceipt(key, receipt); },
      },
      onFailure: event => logger.warn({ statusCode: event.statusCode }, 'capture.soliq_failed'),
    });
    const receipt = await client.getReceipt(url);
    const context = await captureContext(uid, timezone);
    return receiptDrafts(uid, receipt, context);
  });
}

export async function capturePhoto(uid: string, buffer: Buffer, timezone?: string) {
  return withCaptureQuota(uid, true, async () => {
    const context = await captureContext(uid, timezone);
    const extracted = await extractCapturePhoto(uid, buffer, context);
    return receiptDrafts(uid, extracted.receipt, context, extracted);
  });
}
