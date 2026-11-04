import { createHash, createHmac } from 'node:crypto';
import { AppError } from '../utils/AppError';
import { receiptText } from './privacy';

export const SOLIQ_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SOLIQ_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface SoliqQr {
  terminalId: string;
  paymentNo: string;
  paymentDate: string;
  fiscalSign?: string;
  fiscalSignHash?: string;
}

export interface SoliqReceiptItem {
  name: string;
  quantity: number;
  price: number;
  discount: number;
  amount: number;
  ikpu?: string;
  categoryId: null;
}

export interface SoliqReceipt {
  kind: 'soliq';
  receiptKey: string;
  merchant: { tin: string | null; name: string | null; address: string | null };
  date: string;
  total: number;
  cardTotal?: number;
  cashTotal?: number;
  /** Present (true) only for a refund receipt. */
  isRefund?: true;
  items: SoliqReceiptItem[];
}

export interface SoliqCache {
  get(receiptKey: string): Promise<{ receipt: SoliqReceipt; expiresAt: number } | null>;
  set(receiptKey: string, receipt: SoliqReceipt, expiresAt: number): Promise<void>;
}

export interface SoliqFailure {
  event: 'capture.soliq_failed';
  statusCode: number | null;
}

interface SoliqClientOptions {
  signingKey: string;
  fetch?: typeof fetch;
  cache?: SoliqCache;
  now?: () => number;
  onFailure?: (event: SoliqFailure) => void;
  /** Soliq money fields divided by this give currency units. 1 = already sum; 100 = tiyin. */
  amountDivisor?: number;
}

function invalidQr(): never {
  throw new AppError(400, 'invalid_soliq_url', 'Invalid Soliq receipt URL.');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result && result.length <= maxLength ? result : null;
}

function tin(value: unknown): string | null {
  const result = text(value, 14);
  return result && /^(?:\d{9}|\d{14})$/.test(result) ? result : null;
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER
    ? result
    : undefined;
}

function receiptDate(value: unknown): string | null {
  let source = text(value, 40);
  if (!source) return null;
  if (/^\d{14}$/.test(source)) {
    source = `${source.slice(0, 4)}-${source.slice(4, 6)}-${source.slice(6, 8)}T${source.slice(8, 10)}:${source.slice(10, 12)}:${source.slice(12, 14)}`;
  }
  // Soliq's own format is local Tashkent time: '21.10.2026 12:56:20'.
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}:\d{2}:\d{2})$/.exec(source);
  if (dotted) source = `${dotted[3]}-${dotted[2]}-${dotted[1]}T${dotted[4]}`;
  source = source.replace(' ', 'T');
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(
      source,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  if (
    calendar.getUTCFullYear() !== +year ||
    calendar.getUTCMonth() !== +month - 1 ||
    calendar.getUTCDate() !== +day ||
    calendar.getUTCHours() !== +hour ||
    calendar.getUTCMinutes() !== +minute ||
    calendar.getUTCSeconds() !== +second
  )
    return null;
  const result = match[7] ? source : `${source}+05:00`;
  return Number.isFinite(Date.parse(result)) ? result : null;
}

async function responseJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error('Invalid Soliq response size.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Invalid Soliq response size.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function parseSoliqUrl(input: string): SoliqQr {
  if (typeof input !== 'string' || input.length > 2048) return invalidQr();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalidQr();
  }
  if (
    url.protocol !== 'https:' ||
    !['ofd.soliq.uz', 'new-ofd.soliq.uz'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !/^\/(?:epi|check)\/?$/.test(url.pathname)
  )
    return invalidQr();
  const param = (key: string): string | null => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) return null;
    return values[0];
  };
  const terminalId = param('t');
  const paymentNo = param('r');
  const paymentDate = param('c');
  const fiscalSign = param('s');
  const fiscalSignHash = param('h');
  if (
    !terminalId ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(terminalId) ||
    !paymentNo ||
    !/^\d{1,20}$/.test(paymentNo) ||
    !paymentDate ||
    !receiptDate(paymentDate) ||
    (url.searchParams.has('s') && !fiscalSign) ||
    (url.searchParams.has('h') && !fiscalSignHash) ||
    (!fiscalSign && !fiscalSignHash) ||
    (fiscalSign && fiscalSignHash) ||
    (fiscalSign && !/^[A-Za-z0-9_-]{1,128}$/.test(fiscalSign)) ||
    (fiscalSignHash && !/^[A-Za-z0-9+/_=-]{1,256}$/.test(fiscalSignHash))
  )
    return invalidQr();
  return {
    terminalId,
    paymentNo: paymentNo.replace(/^0+(?=\d)/, ''),
    paymentDate,
    ...(fiscalSign ? { fiscalSign } : { fiscalSignHash: fiscalSignHash! }),
  };
}

export function createSoliqSignature(input: {
  terminalId: string;
  paymentNo: string;
  timestamp: string | number;
  signingKey: string;
}): string {
  return createHmac('sha256', input.signingKey)
    .update(`${input.terminalId}:${input.paymentNo}:${input.timestamp}`)
    .digest('hex');
}

export function soliqReceiptKey(qr: SoliqQr): string {
  return createHash('sha256')
    .update(JSON.stringify([qr.terminalId, qr.paymentNo, qr.fiscalSign ?? qr.fiscalSignHash]))
    .digest('hex');
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Σ line paid ≈ total. A mismatch means low confidence on the amount, never an exception. */
export function receiptItemsAgree(receipt: Pick<SoliqReceipt, 'items' | 'total'>): boolean {
  if (!receipt.items.length) return false;
  const sum = receipt.items.reduce((value, item) => value + item.amount, 0);
  return Math.abs(sum - receipt.total) <= Math.max(1, receipt.total * 0.005);
}

/**
 * Real response: `{ success, message, status, data }`. Money is in sum. TINs are JSON numbers.
 * Items: `amount` = quantity, `goodPrice` = unit price, `price` = line total before discount,
 * `discount` = line discount, so the line paid is price - discount.
 * Only an explicit allowlist crosses this boundary: data.tin and the items, plus extraInfo.companyName,
 * extraInfo.merchantTin and extraInfo.address. Every other extraInfo key (phone, card numbers, taxi trip
 * data, flight passport/PINFL, cadastral and account numbers, ...) is never read into the result.
 */
export function mapSoliqReceipt(raw: unknown, qr: SoliqQr, amountDivisor = 1): SoliqReceipt {
  const divisor = Number.isFinite(amountDivisor) && amountDivisor > 0 ? amountDivisor : 1;
  const money = (value: number | undefined): number | undefined =>
    value === undefined || divisor === 1 ? value : round2(value / divisor);
  const envelope = record(raw);
  const data = Object.hasOwn(envelope, 'data') ? record(envelope.data) : envelope;
  const payment = Object.hasOwn(data, 'payment') ? record(data.payment) : data;
  const extra = record(payment.extraInfo);
  if (!Array.isArray(payment.paymentDetails) || payment.paymentDetails.length > 5000) {
    throw new Error('Invalid Soliq receipt shape.');
  }
  const details = payment.paymentDetails.map(record);
  const cardTotal = money(numeric(payment.cardTotal));
  const cashTotal = money(numeric(payment.cashTotal));
  if (
    (payment.cardTotal != null && cardTotal === undefined) ||
    (payment.cashTotal != null && cashTotal === undefined)
  ) {
    throw new Error('Invalid Soliq receipt totals.');
  }
  const total =
    cardTotal !== undefined || cashTotal !== undefined
      ? (cardTotal ?? 0) + (cashTotal ?? 0)
      : money(numeric(payment.total));
  const date = receiptDate(payment.paymentDate ?? payment.date ?? qr.paymentDate);
  if (total === undefined || !Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER || !date) {
    throw new Error('Invalid Soliq receipt totals or date.');
  }
  const items = details.map((item): SoliqReceiptItem => {
    const name = text(item.name);
    const quantity = numeric(item.amount);
    const before = money(numeric(item.price));
    const discount = money(numeric(item.discount ?? 0));
    const unit = money(numeric(item.goodPrice));
    if (
      !name ||
      quantity === undefined ||
      quantity <= 0 ||
      before === undefined ||
      discount === undefined ||
      discount > before
    )
      throw new Error('Invalid Soliq receipt item.');
    // Codes are strings; a numeric code would have lost its leading zero, so it is not guessed.
    const ikpu = typeof item.productCode === 'string' ? text(item.productCode, 32) : null;
    return {
      name: receiptText(name) || 'Item',
      quantity,
      price: unit ?? round2(before / quantity),
      discount,
      amount: round2(before - discount),
      ...(ikpu && /^\d+$/.test(ikpu) ? { ikpu } : {}),
      categoryId: null,
    };
  });
  // The real seller: extraInfo.merchantTin, else the most common comitentTin, else the aggregator's tin.
  const comitents = new Map<string, number>();
  for (const item of details) {
    const value = tin(item.comitentTin);
    if (value) comitents.set(value, (comitents.get(value) ?? 0) + 1);
  }
  const comitent = [...comitents].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const sellerTin = tin(extra.merchantTin) ?? comitent ?? tin(payment.tin);
  // fiscalSign is read only to canonicalise the dedupe hash between the `s` and `h` QR variants.
  const actualSign = text(extra.fiscalSign, 128) ?? text(payment.fiscalSign, 128);
  // Soliq sends refundPaymentId "0" on ordinary sales, so only a non-zero id marks a refund.
  const refundId = payment.refundPaymentId;
  const refund = payment.isRefund === 1 || payment.isRefund === true || payment.isRefund === '1' ||
    (refundId !== undefined && refundId !== null && !/^0*$/.test(String(refundId).trim()));
  return {
    kind: 'soliq',
    receiptKey: soliqReceiptKey(actualSign ? { ...qr, fiscalSign: actualSign } : qr),
    merchant: {
      tin: sellerTin,
      name: receiptText(text(extra.companyName) ?? '') || null,
      address: receiptText(text(extra.address) ?? '') || null,
    },
    date,
    total,
    ...(cardTotal !== undefined ? { cardTotal } : {}),
    ...(cashTotal !== undefined ? { cashTotal } : {}),
    ...(refund ? { isRefund: true as const } : {}),
    items,
  };
}

export class SoliqClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: SoliqClientOptions) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getReceipt(url: string): Promise<SoliqReceipt> {
    const qr = parseSoliqUrl(url);
    const cacheKey = soliqReceiptKey(qr);
    try {
      const cached = await this.options.cache?.get(cacheKey);
      if (cached && cached.expiresAt > this.now()) return structuredClone(cached.receipt);
    } catch {
      /* Cache outages must not disable receipt capture. */
    }
    if (!this.options.signingKey.trim()) return this.unavailable(null);
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let status: number | null = null;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let receipt: SoliqReceipt;
      try {
        // Unix SECONDS: milliseconds are answered with 401 "request expired".
        const timestamp = String(Math.floor(this.now() / 1000));
        receipt = await Promise.race([
          (async () => {
            const response = await this.request(
              `https://new-ofd.soliq.uz/api/payment${qr.fiscalSignHash ? '/mobile-dashboard' : ''}`,
              {
                method: 'POST',
                redirect: 'error',
                signal: controller.signal,
                headers: {
                  'Content-Type': 'application/json',
                  'X-Timestamp': timestamp,
                  'X-Signature': createSoliqSignature({
                    ...qr,
                    timestamp,
                    signingKey: this.options.signingKey,
                  }),
                },
                body: JSON.stringify({
                  terminalId: qr.terminalId,
                  paymentNo: qr.paymentNo,
                  paymentDate: qr.paymentDate,
                  paymentType: qr.terminalId.startsWith('EP') ? 'CHECK_EPI' : 'CHECK',
                  ...(qr.fiscalSignHash
                    ? { fiscalSignHash: qr.fiscalSignHash }
                    : { fiscalSign: qr.fiscalSign }),
                }),
              },
            );
            status = response.status;
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error('Soliq upstream failure.');
            }
            return mapSoliqReceipt(await responseJson(response), qr, this.options.amountDivisor);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Soliq timeout.'));
            }, SOLIQ_TIMEOUT_MS);
          }),
        ]);
      } catch {
        lastStatus = status;
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      try {
        await this.options.cache?.set(
          cacheKey,
          structuredClone(receipt),
          this.now() + SOLIQ_CACHE_TTL_MS,
        );
      } catch {
        /* A successful receipt remains usable without the cache. */
      }
      return receipt;
    }
    return this.unavailable(lastStatus);
  }

  private unavailable(statusCode: number | null): never {
    try {
      this.options.onFailure?.({ event: 'capture.soliq_failed', statusCode });
    } catch {
      /* Best effort. */
    }
    throw new AppError(
      502,
      'soliq_unavailable',
      'Soliq is unavailable. Try a photo of the receipt.',
    );
  }
}
