import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSoliqSignature,
  mapSoliqReceipt,
  parseSoliqUrl,
  receiptItemsAgree,
  SOLIQ_CACHE_TTL_MS,
  SoliqClient,
  soliqReceiptKey,
  type SoliqCache,
} from '../../src/capture/soliq';

// Hand-written synthetic receipts only; these identifiers do not represent real purchases.
const url = 'https://ofd.soliq.uz/epi?t=EPTEST001&r=42&c=20261103123000&s=123456789';
const qr = parseSoliqUrl(url);
const now = Date.parse('2026-11-04T00:00:00Z');
// Exact real shape (types and key names), synthetic values. TINs are JSON numbers, dates are
// 'DD.MM.YYYY HH:mm:ss' in Tashkent time, money is in sum, and for items `amount` is the QUANTITY,
// `goodPrice` the unit price, `price` the line total before discount.
const EXTRA_INFO_KEYS = [
  'fiscalSign', 'companyName', 'fiscalSignHash', 'taxiInfoTin', 'taxiInfoCardNumber', 'refundPaymentId',
  'phoneNumber', 'qrPaymentId', 'qrPaymentProvider', 'cashedOutFromCard', 'pptId', 'cardType', 'merchantTin',
  'pickUpNs10', 'pickUpNs11', 'pickUpAddress', 'receiptType', 'paymentType', 'latitude', 'longitude',
  'cardNumber', 'tripStartLatitude', 'tripStartLongitude', 'tripStartAddress', 'tripEndLatitude',
  'tripEndLongitude', 'tripEndAddress', 'cadastralNumber', 'accountNumber', 'qrSalePointId', 'address',
  'flightPassportNumber', 'flightPinfl', 'flightNumber', 'flightSeatNumber',
] as const;
const ALLOWED_EXTRA = ['companyName', 'merchantTin', 'address'];
const line = (over: Record<string, unknown>) => ({
  id: 1, name: 'Synthetic item', barcode: 'LEAK_barcode', productCode: '', productName: 'LEAK_productName',
  labelErrorCode: null, vatPercent: 12, packageCode: 'LEAK_packageCode', packageName: 'LEAK_packageName',
  voucher: 'LEAK_voucher', refundPaymentId: null, comitentTin: 100000003, productErrorCode: null,
  productGroup: null, goodPrice: 0, price: 0, remains: 0, vat: 0, remainingVat: 0, amount: 1, discount: 0,
  other: 0, cardRatio: 0, ...over,
});
const fixture = (): any => ({
  paymentId: 7, ns10Code: 1, ns11Code: 2, tin: 100000001, terminalId: 'EPTEST001', paymentNo: 42,
  paymentDate: '03.11.2026 12:30:20', cashTotal: 1000, cardTotal: 19000, vatTotal: 2143,
  created: '03.11.2026 12:30:25', updated: '03.11.2026 12:30:26', fiscalSignHash: 'LEAK_hash',
  terminalStateId: 1, isRefund: 0, receiptType: 1, refundPaymentId: null, labels: null,
  kkmName: 'LEAK_kkm', kkmSerialNumber: 'LEAK_serial', statusMessage: null,
  extraInfo: {
    ...Object.fromEntries(EXTRA_INFO_KEYS.map((key) => [key, `LEAK_${key}`])),
    fiscalSign: '123456789',
    companyName: 'Synthetic market',
    merchantTin: 100000002,
    address: 'Test street 1',
    latitude: 41.123456, longitude: 69.654321, tripStartLatitude: 41.111111, tripEndLongitude: 69.222222,
  },
  paymentDetails: [
    line({ name: 'Synthetic bread', productCode: '01901001001000000', goodPrice: 6000, price: 12000,
      amount: 2, discount: 2000, vat: 1200 }),
    line({ name: 'Synthetic soap', goodPrice: 10000, price: 10000, amount: 1, discount: 0 }),
  ],
});
const envelope = (data: unknown = fixture()) => ({ success: true, message: 'OK', status: 200, data });
const response = (value: unknown = envelope(), status = 200) =>
  new Response(JSON.stringify(value), { status });
const seconds = String(now / 1000);
const client = (
  request: typeof fetch,
  options: { cache?: SoliqCache; onFailure?: ReturnType<typeof vi.fn> } = {},
) => new SoliqClient({ signingKey: 'synthetic-key', fetch: request, now: () => now, ...options });

afterEach(() => vi.useRealTimers());

describe('Soliq QR URLs', () => {
  it.each([
    url,
    url.replace('/epi?', '/check?'),
    url.replace('/epi?', '/check/?'),
    url.replace('ofd.soliq.uz', 'new-ofd.soliq.uz'),
    url.replace('c=20261103123000', 'c=2026-11-03T12%3A30%3A00%2B05%3A00'),
  ])('parses supported receipt URLs: %s', (value) => {
    expect(parseSoliqUrl(value)).toMatchObject({
      terminalId: 'EPTEST001',
      paymentNo: '42',
      fiscalSign: '123456789',
    });
  });

  it('handles the h hash variant without retaining a fiscalSign', () => {
    expect(parseSoliqUrl(url.replace('s=123456789', 'h=synthetic_hash%3D'))).toEqual({
      terminalId: 'EPTEST001',
      paymentNo: '42',
      paymentDate: '20261103123000',
      fiscalSignHash: 'synthetic_hash=',
    });
  });

  it.each([
    url.replace('https:', 'http:'),
    url.replace('https:', 'file:'),
    url.replace('ofd.soliq.uz', 'ofd.soliq.uz.attacker.test'),
    url.replace('ofd.soliq.uz', 'attacker.test'),
    url.replace('ofd.soliq.uz', 'ofd.soliq.uz:444'),
    url.replace('ofd.soliq.uz', 'user:pass@ofd.soliq.uz'),
    url.replace('/epi?', '/api/payment?'),
    url + '#fragment',
    url + '&t=OTHER',
    url + '&s=duplicate',
    url + '&h=hash',
    url.replace('&s=123456789', ''),
    url.replace('r=42', 'r=-42'),
    url.replace('c=20261103123000', 'c=20260230123000'),
    url.replace('c=20261103123000', 'c=20261103253000'),
    url.replace('t=EPTEST001', 't=bad%2Fid'),
    url.replace('s=123456789', 's='),
    url.replace('s=123456789', 'h=hash&h=other'),
    'not a url',
  ])('rejects unsafe or malformed URLs: %s', (value) => {
    expect(() => parseSoliqUrl(value)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'invalid_soliq_url' }),
    );
  });

  it('normalizes receipt numbers and ignores query order for dedupe', () => {
    expect(soliqReceiptKey(parseSoliqUrl(url.replace('r=42', 'r=00042')))).toBe(
      soliqReceiptKey(qr),
    );
    expect(
      soliqReceiptKey(
        parseSoliqUrl('https://ofd.soliq.uz/check?s=123456789&c=20261103123000&r=42&t=EPTEST001'),
      ),
    ).toBe(soliqReceiptKey(qr));
  });
});

describe('Soliq signing and mapping', () => {
  it('signs the exact terminal, receipt number and timestamp with HMAC-SHA256', () => {
    expect(createSoliqSignature({ ...qr, timestamp: '123', signingKey: 'synthetic-key' })).toBe(
      createHmac('sha256', 'synthetic-key').update('EPTEST001:42:123').digest('hex'),
    );
  });

  it('keeps discounts, quantities, totals and IKPU, selecting the actual merchant', () => {
    const receipt = mapSoliqReceipt(fixture(), qr);
    expect(receipt).toEqual({
      kind: 'soliq',
      receiptKey: createHash('sha256')
        .update(JSON.stringify(['EPTEST001', '42', '123456789']))
        .digest('hex'),
      merchant: { tin: '100000002', name: 'Synthetic market', address: 'Test street 1' },
      date: '2026-11-03T12:30:20+05:00',
      total: 20000,
      cardTotal: 19000,
      cashTotal: 1000,
      items: [
        {
          name: 'Synthetic bread',
          quantity: 2,
          price: 6000,
          discount: 2000,
          amount: 10000,
          ikpu: '01901001001000000',
          categoryId: null,
        },
        {
          name: 'Synthetic soap',
          quantity: 1,
          price: 10000,
          discount: 0,
          amount: 10000,
          categoryId: null,
        },
      ],
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/LEAK|41\.123456|69\.654321|extraInfo/);
    expect(receiptItemsAgree(receipt)).toBe(true);
  });

  it('maps both real receipt shapes: no discount, and discounts where only price - discount is paid', () => {
    const a = fixture();
    a.cashTotal = 0; a.cardTotal = 43000;
    a.paymentDetails = [line({ name: 'A1', goodPrice: 10000, price: 10000 }), line({ name: 'A2', goodPrice: 13000, price: 13000 }),
      line({ name: 'A3', goodPrice: 20000, price: 20000 })];
    const receiptA = mapSoliqReceipt(envelope(a), qr);
    expect(receiptA.total).toBe(43000);
    expect(receiptItemsAgree(receiptA)).toBe(true);
    const b = fixture();
    b.cashTotal = 0; b.cardTotal = 120800;
    b.paymentDetails = [line({ name: 'B1', goodPrice: 50000, price: 50000, discount: 10000 }),
      line({ name: 'B2', goodPrice: 40000, price: 40000, discount: 8000 }),
      line({ name: 'B3', goodPrice: 31000, price: 31000, discount: 6200 }),
      line({ name: 'B4', goodPrice: 15000, price: 30000, amount: 2, discount: 6000 })];
    const receiptB = mapSoliqReceipt(envelope(b), qr);
    expect(receiptB.items.reduce((sum, item) => sum + item.price * item.quantity, 0)).toBe(151000);
    expect(receiptB.items.reduce((sum, item) => sum + item.discount, 0)).toBe(30200);
    expect(receiptB.items.map((item) => item.amount)).toEqual([40000, 32000, 24800, 24000]);
    expect(receiptB.total).toBe(120800);
    expect(receiptItemsAgree(receiptB)).toBe(true);
    // A mismatch is low confidence for the caller, never an exception.
    expect(receiptItemsAgree({ ...receiptB, total: 100000 })).toBe(false);
    expect(receiptItemsAgree({ ...receiptB, items: [] })).toBe(false);
  });

  it('keeps fractional quantities of weighed goods and derives a missing unit price', () => {
    const raw = fixture();
    raw.cashTotal = 0; raw.cardTotal = 7000;
    raw.paymentDetails = [line({ name: 'Cheese', amount: 0.35, goodPrice: 20000, price: 7000 })];
    expect(mapSoliqReceipt(raw, qr).items[0]).toMatchObject({ quantity: 0.35, price: 20000, discount: 0, amount: 7000 });
    raw.paymentDetails = [line({ name: 'Cheese', amount: 0.35, goodPrice: undefined, price: 7000 })];
    expect(mapSoliqReceipt(raw, qr).items[0]).toMatchObject({ quantity: 0.35, price: 20000, amount: 7000 });
  });

  it('accepts the DD.MM.YYYY HH:mm:ss local Tashkent date and rejects impossible ones', () => {
    const raw = fixture();
    raw.paymentDate = '21.10.2026 12:56:20';
    expect(mapSoliqReceipt(raw, qr).date).toBe('2026-10-21T12:56:20+05:00');
    for (const bad of ['31.02.2026 12:00:00', '21.10.2026 25:00:00', '2026.10.21 12:00:00']) {
      expect(() => mapSoliqReceipt({ ...raw, paymentDate: bad }, qr)).toThrow();
    }
  });

  it('flags refund receipts (isRefund or refundPaymentId) and leaves ordinary ones unmarked', () => {
    expect(mapSoliqReceipt({ ...fixture(), isRefund: 1 }, qr).isRefund).toBe(true);
    expect(mapSoliqReceipt({ ...fixture(), refundPaymentId: 99 }, qr).isRefund).toBe(true);
    expect(mapSoliqReceipt(fixture(), qr)).not.toHaveProperty('isRefund');
  });

  it('only companyName, merchantTin and address come out of extraInfo, even when every key is filled', () => {
    const raw = fixture();
    expect(Object.keys(raw.extraInfo).sort()).toEqual([...EXTRA_INFO_KEYS].sort());
    const serialized = JSON.stringify(mapSoliqReceipt(envelope(raw), qr));
    for (const key of EXTRA_INFO_KEYS.filter((k) => !ALLOWED_EXTRA.includes(k))) {
      expect(serialized, key).not.toContain(`LEAK_${key}`);
    }
    expect(serialized).not.toMatch(/41\.123456|69\.654321|41\.111111|69\.222222|LEAK|123456789"/);
    expect(JSON.parse(serialized).merchant).toEqual({ tin: '100000002', name: 'Synthetic market', address: 'Test street 1' });
  });

  it('scrubs buyer data embedded in allowed merchant and item text fields', () => {
    const raw = fixture();
    raw.extraInfo.companyName = 'Market; phone: +998901234567';
    raw.extraInfo.address = 'Test street; card: 8600123412341234';
    raw.paymentDetails[0].name = 'Bread +998 90 123 45 67';
    const serialized = JSON.stringify(mapSoliqReceipt(raw, qr));
    expect(serialized).not.toMatch(/998|8600123412341234|phone:|card:/);
    expect(serialized).toContain('Bread [redacted]');
  });

  it('uses merchantTin, then the most common comitentTin, then the aggregator tin (numbers or null)', () => {
    const raw = fixture();
    expect(mapSoliqReceipt(raw, qr).merchant.tin).toBe('100000002');
    raw.extraInfo.merchantTin = null;
    expect(mapSoliqReceipt(raw, qr).merchant.tin).toBe('100000003');
    raw.paymentDetails = [line({ comitentTin: 100000004 }), line({ comitentTin: 100000005 }), line({ comitentTin: 100000005 })]
      .map((item, i) => ({ ...item, name: `Item ${i}`, goodPrice: 6000, price: 6000 }));
    raw.cashTotal = 0; raw.cardTotal = 18000;
    expect(mapSoliqReceipt(raw, qr).merchant.tin).toBe('100000005');
    raw.paymentDetails.forEach((item: any) => { item.comitentTin = null; });
    expect(mapSoliqReceipt(raw, qr).merchant.tin).toBe('100000001');
    raw.tin = 'invalid';
    expect(mapSoliqReceipt(raw, qr).merchant.tin).toBeNull();
  });

  it.each(['data', 'payment', 'dataPayment'])('accepts the %s response envelope', (shape) => {
    const raw = fixture();
    const wrapped =
      shape === 'data'
        ? envelope(raw)
        : shape === 'payment'
          ? { payment: raw }
          : { data: { payment: raw } };
    expect(mapSoliqReceipt(wrapped, qr).total).toBe(20000);
  });

  it('canonicalizes hash-QR dedupe using the returned fiscal sign', () => {
    const hashQr = parseSoliqUrl(url.replace('s=123456789', 'h=synthetic_hash'));
    expect(mapSoliqReceipt(fixture(), hashQr).receiptKey).toBe(
      mapSoliqReceipt(fixture(), qr).receiptKey,
    );
  });

  it.each([
    { ...fixture(), cardTotal: 'invalid', cashTotal: 1000 },
    { ...fixture(), cardTotal: -1, cashTotal: undefined },
    { ...fixture(), cardTotal: 'NaN', cashTotal: undefined },
    { ...fixture(), paymentDate: '2026-02-30 12:00:00' },
    { ...fixture(), paymentDetails: null },
    { ...fixture(), paymentDetails: [{ name: 'Test', quantity: 1, price: 100, amount: -1 }] },
  ])('rejects malformed data rather than producing an inaccurate draft', (raw) => {
    expect(() => mapSoliqReceipt(raw, qr)).toThrow();
  });
});

describe('Soliq client', () => {
  it('posts only validated fields to the fixed upstream, with redirects disabled', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    await client(request).getReceipt(url);
    const [target, options] = request.mock.calls[0];
    expect(target).toBe('https://new-ofd.soliq.uz/api/payment');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        // Unix seconds: milliseconds are answered with 401 "request expired".
        'X-Timestamp': seconds,
        'X-Signature': createSoliqSignature({ ...qr, timestamp: seconds, signingKey: 'synthetic-key' }),
      },
    });
    expect(seconds).toMatch(/^\d{10}$/);
    expect(createSoliqSignature({ ...qr, timestamp: seconds, signingKey: 'synthetic-key' })).toBe(
      createHmac('sha256', 'synthetic-key').update(`EPTEST001:42:${seconds}`).digest('hex'),
    );
    expect(JSON.parse(options!.body as string)).toEqual({ ...qr, paymentType: 'CHECK_EPI' });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
  });

  it('posts h receipts to mobile-dashboard with CHECK for ordinary terminals', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    await client(request).getReceipt(
      url.replace('EPTEST001', 'TEST001').replace('s=123456789', 'h=synthetic_hash'),
    );
    expect(request.mock.calls[0][0]).toBe('https://new-ofd.soliq.uz/api/payment/mobile-dashboard');
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({
      paymentType: 'CHECK',
      fiscalSignHash: 'synthetic_hash',
    });
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).not.toHaveProperty('fiscalSign');
  });

  it('retries exactly once on a failure and stores only the safe receipt for 30 days', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response());
    const cache: SoliqCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const receipt = await client(request, { cache }).getReceipt(url);
    expect(request).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledWith(soliqReceiptKey(qr), receipt, now + SOLIQ_CACHE_TTL_MS);
    expect(JSON.stringify(vi.mocked(cache.set).mock.calls)).not.toMatch(/LEAK|phoneNumber/);
  });

  it('leaks no extraInfo value through the receipt, the cache payload or failure logs', async () => {
    const cache: SoliqCache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) };
    const onFailure = vi.fn();
    const ok = await client(vi.fn<typeof fetch>().mockResolvedValue(response()), { cache, onFailure }).getReceipt(url);
    // A failing upstream that echoes the same data must not reach the logs either.
    const failing = client(vi.fn<typeof fetch>().mockImplementation(async () => response(envelope(), 500)), { cache, onFailure });
    await expect(failing.getReceipt(url.replace('r=42', 'r=43'))).rejects.toMatchObject({ code: 'soliq_unavailable' });
    const everything = JSON.stringify([ok, vi.mocked(cache.set).mock.calls, onFailure.mock.calls]);
    expect(everything).not.toMatch(/LEAK|41\.123456|69\.654321/);
    expect(onFailure).toHaveBeenCalledWith({ event: 'capture.soliq_failed', statusCode: 500 });
  });

  it('uses an unexpired cache without a signing key or network request', async () => {
    const request = vi.fn<typeof fetch>();
    const receipt = mapSoliqReceipt(fixture(), qr);
    const cache: SoliqCache = {
      get: vi.fn().mockResolvedValue({ receipt, expiresAt: now + 1 }),
      set: vi.fn(),
    };
    expect(
      await new SoliqClient({ signingKey: '', fetch: request, cache, now: () => now }).getReceipt(
        url,
      ),
    ).toEqual(receipt);
    expect(request).not.toHaveBeenCalled();
  });

  it('refreshes expired receipts and tolerates cache read/write failures', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const cache: SoliqCache = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ receipt: mapSoliqReceipt(fixture(), qr), expiresAt: now })
        .mockRejectedValueOnce(new Error('cache down')),
      set: vi.fn().mockRejectedValue(new Error('cache down')),
    };
    const service = client(request, { cache });
    expect((await service.getReceipt(url)).total).toBe(20000);
    expect((await service.getReceipt(url)).total).toBe(20000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns a safe 502 and logs only the status after two upstream failures', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ phoneNumber: '+998901234567' }, 403));
    const onFailure = vi.fn();
    await expect(client(request, { onFailure }).getReceipt(url)).rejects.toMatchObject({
      statusCode: 502,
      code: 'soliq_unavailable',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      event: 'capture.soliq_failed',
      statusCode: 403,
    });
  });

  it('returns a safe 502 for a missing key without an upstream call', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      new SoliqClient({ signingKey: '', fetch: request }).getReceipt(url),
    ).rejects.toMatchObject({ statusCode: 502, code: 'soliq_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('retries malformed JSON and logs only the successful HTTP status on exhaustion', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('not JSON'));
    const onFailure = vi.fn();
    await expect(client(request, { onFailure }).getReceipt(url)).rejects.toMatchObject({
      code: 'soliq_unavailable',
    });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      event: 'capture.soliq_failed',
      statusCode: 200,
    });
  });

  it('enforces a 10-second timeout and one retry even when the injected fetch ignores abort', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const onFailure = vi.fn();
    const pending = client(request, { onFailure }).getReceipt(url);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'soliq_unavailable' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      event: 'capture.soliq_failed',
      statusCode: null,
    });
  });

  it('bounds response bodies even without a Content-Length header', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(client(request).getReceipt(url)).rejects.toMatchObject({
      code: 'soliq_unavailable',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized declared bodies before reading them', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
      );
    await expect(client(request).getReceipt(url)).rejects.toMatchObject({
      code: 'soliq_unavailable',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not expose network errors containing receipt or buyer information', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('buyer +998901234567 8600123412341234'));
    const onFailure = vi.fn();
    await expect(client(request, { onFailure }).getReceipt(url)).rejects.toMatchObject({
      statusCode: 502,
      code: 'soliq_unavailable',
      message: 'Soliq is unavailable. Try a photo of the receipt.',
    });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      event: 'capture.soliq_failed',
      statusCode: null,
    });
  });

  it('does not send any upstream request for invalid QR input', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(client(request).getReceipt('https://attacker.test/check')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
