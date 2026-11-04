import { randomUUID } from 'node:crypto';
import { filterQuery, limitQuery, orderQuery, queryTable, readDocument } from '../db/documents';
import { getProfile } from '../repositories/profile.repository';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories';
import type { Category } from '../domain/types';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { STANDARD_CATEGORY_KEYS, inferCaptureCategory } from './categories';
import { cacheReceipt, findReceiptDuplicate, getCachedReceipt, getCaptureMerchantNames, recordIssuedMerchant, type ReceiptSource } from './repository';
import { SoliqClient, mapSoliqReceipt, parseSoliqUrl, rawMatchesQr, receiptItemsAgree, sanitizeSoliqRaw, soliqReceiptKey, SOLIQ_RAW_MAX_BYTES } from './soliq';
import { AppError } from '../utils/AppError';
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

export async function captureVoice(uid: string, buffer: Buffer, mime: string, timezone?: string, language?: 'uz' | 'ru' | 'en', signal?: AbortSignal) {
  return withCaptureQuota(uid, true, async ({ release }) => {
    const context = await captureContext(uid, timezone);
    const transcript = await transcribeCapture(uid, buffer, mime, context, language);
    const drafts = transcript ? await parseCaptureVoice(uid, transcript, context) : [];
    // Silence or unrelated speech is not a recognition the user should pay a free-tier slot for.
    if (!drafts.length) release();
    return { transcript, drafts };
  }, { signal });
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
  options: { currency?: string; amountLow?: boolean; dateLow?: boolean; receiptSource?: ReceiptSource } = {}) {
  // Receipts are expenses: only expense standard keys may be guessed, only expense categories mapped.
  const expenseKeys = STANDARD_CATEGORY_KEYS.filter(key => DEFAULT_CATEGORIES.some(c =>
    c.type === 'expense' && c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') === key));
  const categories = context.categories.filter(c => c.type === 'expense' || c.type === 'both');
  const guess = () => guessCaptureCategory(uid, `${receipt.merchant.name ?? ''}; ${receipt.items.slice(0, 15).map(i => i.name).join(', ')}`, expenseKeys);
  // Only Soliq receipts carry trustworthy item codes and a server-fetched seller TIN. A photo's TIN and
  // codes are OCR text: they never feed the shared directory or trigger model classification.
  const soliq = receipt.kind === 'soliq';
  // A phone-reported Soliq receipt (receiptSource 'device') is not re-checked by the server: its item
  // codes and names are client data, so they never reach the model-classified shared IKPU map.
  const device = soliq && options.receiptSource === 'device';
  const classifyIkpu = !soliq || device ? undefined : (prefix: string) => guessCaptureCategory(uid,
    `IKPU group ${prefix}: ${receipt.items.filter(i => i.ikpu?.startsWith(prefix)).slice(0, 10).map(i => i.name).join(', ')}`, expenseKeys);
  const inferred = await inferCaptureCategory({ uid, tin: receipt.merchant.tin ?? undefined,
    merchant: receipt.merchant, trustedTin: soliq, deviceReported: device, categories, items: receipt.items, aiGuess: guess, classifyIkpu });
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
  // A refund receipt is money coming back: an income draft. Its category is the user's call (our
  // categories here are expense ones), so it is null and flagged rather than guessed.
  const refund = receipt.isRefund === true;
  if (refund || !inferred.categoryId || inferred.confidence === 'low') low.push('category');
  if (options.amountLow) low.push('amount');
  if (options.dateLow) low.push('date');
  const draft: CaptureDraft = {
    draftId: randomUUID(), type: refund ? 'income' : 'expense', amount: receipt.total, currency: options.currency ?? 'UZS',
    categoryId: refund ? null : inferred.categoryId,
    categoryConfidence: !refund && inferred.categoryId ? inferred.confidence : 'low',
    accountId: null, date: dateInTimezone(new Date(receipt.date), context.timezone),
    comment: receiptComment(receipt.merchant.name, receipt.items.length, context.language),
    lowConfidenceFields: low, items: receipt.items,
  };
  // Remember what we suggested for this seller: learning later accepts only this TIN, and a "changed
  // my suggestion" claim only against this category. Best effort: without it nothing is learned.
  if (receipt.merchant.tin) {
    try {
      await recordIssuedMerchant(uid, receipt.merchant.tin, {
        source: !soliq ? 'photo' : device ? 'device' : 'soliq', suggestedCategoryId: draft.categoryId, draftId: draft.draftId });
    } catch { logger.warn('capture.issue_record_failed'); }
  }
  const duplicateOf = await findReceiptDuplicate(uid, receipt.receiptKey);
  return { receipt, drafts: [draft], ...(duplicateOf ? { duplicateOf } : {}) };
}

/**
 * A phone-reported Soliq receipt: the server never calls Soliq. The allowlist is applied again, the
 * data must belong to the QR that came with it, and nothing but the mapped receipt is kept.
 */
function deviceReceipt(url: string, raw: unknown): { receipt: CaptureReceipt; cacheKey: string } {
  const qr = parseSoliqUrl(url);
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(JSON.stringify(raw) ?? ''); } catch { /* not serializable */ }
  if (bytes > SOLIQ_RAW_MAX_BYTES) throw new AppError(413, 'payload_too_large', 'The receipt data is too large.');
  const clean = sanitizeSoliqRaw(raw);
  if (!rawMatchesQr(clean, qr)) throw new AppError(422, 'receipt_mismatch', 'The receipt data does not belong to this QR code.');
  try {
    // Size and timing only: neither `raw` nor any field of it is ever logged.
    return { receipt: mapSoliqReceipt(clean, qr, env.SOLIQ_AMOUNT_DIVISOR) as CaptureReceipt, cacheKey: soliqReceiptKey(qr) };
  } catch {
    throw new AppError(422, 'receipt_invalid', 'The receipt data could not be read.');
  } finally {
    logger.info({ bytes }, 'capture.soliq_device_received');
  }
}

export async function captureSoliq(uid: string, url: string, timezone?: string, signal?: AbortSignal, raw?: unknown) {
  parseSoliqUrl(url); // A malformed URL is rejected before any quota or network work.
  // Validate a phone-reported body before spending quota or touching the database.
  const reported = raw === undefined ? undefined : deviceReceipt(url, raw);
  return withCaptureQuota(uid, env.CAPTURE_COUNT_SOLIQ, async () => {
    let receipt: CaptureReceipt;
    let receiptSource: ReceiptSource = 'server';
    if (reported) {
      // A receipt this server fetched from Soliq itself beats whatever the phone says about it.
      const verified = await getCachedReceipt<CaptureReceipt>(reported.cacheKey, 'server').catch(() => undefined);
      if (verified) receipt = verified;
      else {
        receipt = reported.receipt;
        receiptSource = 'device';
        // Own cache entry (separate key, source stored): a server fetch never reads or trusts it.
        await cacheReceipt(reported.cacheKey, receipt, 'device').catch(() => logger.warn('capture.cache_write_failed'));
      }
    } else {
      const client = new SoliqClient({
        signingKey: env.SOLIQ_OFD_SIGNING_KEY, amountDivisor: env.SOLIQ_AMOUNT_DIVISOR,
        cache: {
          get: async key => {
            const cached = await getCachedReceipt<CaptureReceipt>(key, 'server');
            return cached ? { receipt: cached as any, expiresAt: Date.now() + 60_000 } : null;
          },
          set: async (key, value) => { await cacheReceipt(key, value, 'server'); },
        },
        onFailure: event => logger.warn({ statusCode: event.statusCode }, 'capture.soliq_failed'),
      });
      receipt = await client.getReceipt(url);
    }
    const context = await captureContext(uid, timezone);
    // Σ(price - discount) must match the total; if not, say so instead of presenting a clean draft.
    return receiptDrafts(uid, receipt, context, { amountLow: !receiptItemsAgree(receipt), receiptSource });
  }, { signal });
}

export async function capturePhoto(uid: string, buffer: Buffer, timezone?: string, signal?: AbortSignal) {
  return withCaptureQuota(uid, true, async () => {
    const context = await captureContext(uid, timezone);
    const extracted = await extractCapturePhoto(uid, buffer, context);
    return receiptDrafts(uid, extracted.receipt, context, extracted);
  }, { signal });
}
