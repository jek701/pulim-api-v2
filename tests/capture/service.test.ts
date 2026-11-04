import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../../src/domain/defaultCategories';

const mocks = vi.hoisted(() => ({
  env: { CAPTURE_COUNT_SOLIQ: false, SOLIQ_OFD_SIGNING_KEY: 'synthetic-key', SOLIQ_AMOUNT_DIVISOR: 1 } as Record<string, unknown>,
  rows: { categories: [] as any[], cards: [] as any[], transactions: [] as any[] },
  infer: vi.fn(), issue: vi.fn(), allowance: vi.fn(), guess: vi.fn(), duplicate: vi.fn(), cached: vi.fn(), cache: vi.fn(),
  usage: vi.fn(), reserve: vi.fn(), refund: vi.fn(), premium: vi.fn(),
  transcribe: vi.fn(), parse: vi.fn(), photo: vi.fn(), profile: vi.fn(), warn: vi.fn(),
}));
vi.mock('../../src/config/env', () => ({ env: mocks.env }));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: mocks.warn, info: vi.fn() } }));
vi.mock('../../src/db/documents', () => ({
  queryTable: (table: string) => ({ table }), filterQuery: (query: any) => query,
  orderQuery: (query: any) => query, limitQuery: (query: any) => query,
  readDocument: async (query: { table: 'categories' | 'cards' | 'transactions' }) => ({
    rows: mocks.rows[query.table].map(({ id, ...data }) => ({ id, data })),
  }),
}));
vi.mock('../../src/repositories/profile.repository', () => ({ getProfile: mocks.profile }));
vi.mock('../../src/capture/categories', async (original) => ({
  ...await original<typeof import('../../src/capture/categories')>(), inferCaptureCategory: mocks.infer,
}));
vi.mock('../../src/capture/repository', () => ({
  findReceiptDuplicate: mocks.duplicate, getCachedReceipt: mocks.cached, cacheReceipt: mocks.cache,
  getCaptureMerchantNames: async (tins: string[]) => tins.map((tin) => `merchant-${tin}`),
  recordIssuedMerchant: mocks.issue, takeCaptureRefund: mocks.allowance, getCaptureUsage: mocks.usage, reserveCaptureUsage: mocks.reserve, refundCaptureUsage: mocks.refund,
}));
vi.mock('../../src/services/entitlement.service', () => ({ getIsPremium: mocks.premium }));
vi.mock('../../src/capture/models', () => ({
  guessCaptureCategory: mocks.guess, transcribeCapture: mocks.transcribe, parseCaptureVoice: mocks.parse,
  extractCapturePhoto: mocks.photo,
}));
import { captureContext, capturePhoto, captureSoliq, captureVoice, receiptComment, receiptDrafts } from '../../src/capture/service';
import type { CaptureReceipt } from '../../src/capture/types';

const categories = DEFAULT_CATEGORIES.map((c) => ({ ...c, id: defaultCategoryId('user', c.type, c.name), userId: 'user', createdAt: 0 }));
const food = categories.find((c) => c.name === 'Food')!;
const shopping = categories.find((c) => c.name === 'Shopping')!;
const context = () => ({ categories, accounts: [], recent: [], merchantNames: [], timezone: 'Asia/Tashkent',
  now: new Date('2026-11-04T12:00:00Z'), language: 'ru' as const });
const receipt = (): CaptureReceipt => ({
  kind: 'soliq', receiptKey: 'a'.repeat(64), merchant: { tin: '123456789', name: 'Synthetic Market', address: null },
  date: '2026-11-03T12:30:00+05:00', total: 40000,
  items: [
    { name: 'Bread', quantity: 1, price: 10000, discount: 0, amount: 10000, ikpu: '01901001001000000', categoryId: null },
    { name: 'Bread 2', quantity: 1, price: 10000, discount: 0, amount: 10000, ikpu: '01901001001000000', categoryId: null },
    { name: 'Soap', quantity: 1, price: 20000, discount: 0, amount: 20000, ikpu: '03401001001000000', categoryId: null },
    { name: 'Mystery', quantity: 1, price: 1, discount: 0, amount: 1, categoryId: null },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.CAPTURE_COUNT_SOLIQ = false;
  mocks.rows.categories = categories; mocks.rows.cards = []; mocks.rows.transactions = [];
  mocks.profile.mockResolvedValue({ language: 'ru', timezone: 'Asia/Tashkent' });
  mocks.duplicate.mockResolvedValue(undefined);
  mocks.issue.mockResolvedValue(undefined); mocks.allowance.mockResolvedValue(true);
  mocks.cached.mockResolvedValue(undefined); mocks.cache.mockResolvedValue(undefined);
  mocks.usage.mockResolvedValue(1); mocks.reserve.mockResolvedValue(true); mocks.refund.mockResolvedValue(undefined);
  mocks.premium.mockResolvedValue(false);
  mocks.infer.mockImplementation(async (input: any) => input.tin
    ? { categoryId: food.id, confidence: 'high', standardKey: 'food' }
    : input.items?.[0]?.ikpu?.startsWith('034')
      ? { categoryId: shopping.id, confidence: 'medium', standardKey: 'shopping' }
      : { categoryId: input.items?.[0]?.ikpu ? food.id : null, confidence: 'medium', standardKey: null });
});

describe('receipt drafts', () => {
  it('builds one expense draft with the merchant category, per-item categories and a localized comment', async () => {
    const result = await receiptDrafts('user', receipt(), context());
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      type: 'expense', amount: 40000, currency: 'UZS', categoryId: food.id, categoryConfidence: 'high',
      accountId: null, date: '2026-11-03T12:30:00+05:00', comment: 'Synthetic Market · 4 позиции',
      lowConfidenceFields: [],
    });
    expect(result.drafts[0].items?.map((item) => item.categoryId)).toEqual([food.id, food.id, shopping.id, food.id]);
    expect(result).not.toHaveProperty('duplicateOf');
  });

  it('asks the model once per distinct IKPU code, not per line, and only for expense keys', async () => {
    mocks.guess.mockResolvedValue(null);
    await receiptDrafts('user', receipt(), context());
    const itemCalls = mocks.infer.mock.calls.filter(([input]) => !input.tin);
    expect(itemCalls).toHaveLength(2);
    const expenseKeys = mocks.infer.mock.calls[0][0].aiGuess ? await (async () => { mocks.guess.mockClear(); await mocks.infer.mock.calls[0][0].aiGuess(); return mocks.guess.mock.calls[0][2]; })() : [];
    expect(expenseKeys).toContain('food');
    expect(expenseKeys).not.toContain('salary');
  });

  it('treats a photo receipt’s TIN and item codes as untrusted: no shared directory, no IKPU classification', async () => {
    await receiptDrafts('user', { ...receipt(), kind: 'photo' }, context());
    for (const [input] of mocks.infer.mock.calls) {
      expect(input.trustedTin).not.toBe(true);
      expect(input.classifyIkpu).toBeUndefined();
    }
    mocks.infer.mockClear();
    await receiptDrafts('user', receipt(), context());
    expect(mocks.infer.mock.calls[0][0]).toMatchObject({ trustedTin: true, classifyIkpu: expect.any(Function) });
  });

  it('records what it suggested for the seller, so learning can verify the TIN and the suggestion later', async () => {
    const result = await receiptDrafts('user', receipt(), context());
    expect(mocks.issue).toHaveBeenCalledWith('user', '123456789', {
      source: 'soliq', suggestedCategoryId: food.id, draftId: result.drafts[0].draftId });
    await receiptDrafts('user', { ...receipt(), kind: 'photo' }, context());
    expect(mocks.issue.mock.calls[1][2]).toMatchObject({ source: 'photo' });
    // A seller without a TIN, or a failing bookkeeping write, never affects the scan.
    mocks.issue.mockClear();
    await receiptDrafts('user', { ...receipt(), merchant: { tin: null, name: 'x', address: null } }, context());
    expect(mocks.issue).not.toHaveBeenCalled();
    mocks.issue.mockRejectedValue(new Error('deadlock'));
    expect((await receiptDrafts('user', receipt(), context())).drafts).toHaveLength(1);
    expect(mocks.warn).toHaveBeenCalledWith('capture.issue_record_failed');
  });

  it('shows an AI suggestion as a highlighted low-confidence category, and null when the user lacks it', async () => {
    mocks.infer.mockResolvedValue({ categoryId: food.id, confidence: 'low', standardKey: 'food' });
    const guessed = await receiptDrafts('user', receipt(), context());
    expect(guessed.drafts[0]).toMatchObject({ categoryId: food.id, categoryConfidence: 'low' });
    expect(guessed.drafts[0].lowConfidenceFields).toEqual(['category']);
    mocks.infer.mockResolvedValue({ categoryId: null, confidence: 'low', standardKey: null });
    const unknown = await receiptDrafts('user', receipt(), context());
    expect(unknown.drafts[0]).toMatchObject({ categoryId: null, categoryConfidence: 'low' });
    expect(unknown.drafts[0].lowConfidenceFields).toContain('category');
  });

  it('flags amount and date from the photo checks and never doubts the account', async () => {
    const result = await receiptDrafts('user', receipt(), context(), { amountLow: true, dateLow: true, currency: 'USD' });
    expect(result.drafts[0]).toMatchObject({ currency: 'USD', lowConfidenceFields: ['amount', 'date'] });
  });

  it('reports a duplicate only for this user and keeps the original date and transaction id', async () => {
    mocks.duplicate.mockResolvedValue({ date: '2026-10-26T10:00:00.000Z', transactionId: 'tx-1' });
    const result = await receiptDrafts('user', receipt(), context());
    expect(mocks.duplicate).toHaveBeenCalledWith('user', 'a'.repeat(64));
    expect(result.duplicateOf).toEqual({ date: '2026-10-26T10:00:00.000Z', transactionId: 'tx-1' });
  });

  it('localizes the item count in every language', () => {
    expect(receiptComment('Korzinka', 1, 'ru')).toBe('Korzinka · 1 позиция');
    expect(receiptComment('Korzinka', 5, 'ru')).toBe('Korzinka · 5 позиций');
    expect(receiptComment('Korzinka', 12, 'ru')).toBe('Korzinka · 12 позиций');
    expect(receiptComment('Korzinka', 22, 'ru')).toBe('Korzinka · 22 позиции');
    expect(receiptComment('Korzinka', 5, 'uz')).toBe('Korzinka · 5 ta mahsulot');
    expect(receiptComment('Korzinka', 1, 'en')).toBe('Korzinka · 1 item');
    expect(receiptComment(null, 0, 'en')).toBe('Receipt');
    expect(receiptComment(null, 3, 'ru')).toBe('3 позиции');
  });
});

describe('soliq capture end to end', () => {
  const url = 'https://ofd.soliq.uz/epi?t=EPTEST001&r=42&c=20261103123000&s=123456789';
  const item = (over: Record<string, unknown>) => ({ name: 'Synthetic bread', productCode: '01901001001000000',
    goodPrice: 40000, price: 40000, amount: 1, discount: 0, comitentTin: 100000002, barcode: 'LEAK_barcode', ...over });
  const data = (over: Record<string, unknown> = {}) => ({
    tin: 100000001, terminalId: 'EPTEST001', paymentNo: 42, paymentDate: '03.11.2026 12:30:20', cardTotal: 40000, cashTotal: 0,
    isRefund: 0, refundPaymentId: null, fiscalSignHash: 'LEAK_hash',
    extraInfo: { fiscalSign: '123456789', companyName: 'Synthetic market', merchantTin: null, address: 'Test street',
      phoneNumber: 'LEAK_phone', cardNumber: 'LEAK_card', flightPassportNumber: 'LEAK_passport', latitude: 41.123456 },
    paymentDetails: [item({})], ...over,
  });
  const upstream = (over: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ success: true, message: 'OK', status: 200, data: data(over) }), { status: 200 });

  it('does not count against the quota by default, and carries no buyer data to the client or the cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream()));
    const result = await captureSoliq('user', url);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(result.quota).toMatchObject({ used: 1, limit: 5, premium: false });
    expect(result.receipt).toMatchObject({ kind: 'soliq', total: 40000, merchant: { tin: '100000002', name: 'Synthetic market' } });
    expect(result.drafts[0].lowConfidenceFields).not.toContain('amount');
    const everything = JSON.stringify([result, mocks.cache.mock.calls, mocks.warn.mock.calls]);
    expect(everything).not.toMatch(/LEAK|41\.123456|phoneNumber|cardNumber/);
    expect(mocks.cache).toHaveBeenCalledOnce();
  });

  it('counts when CAPTURE_COUNT_SOLIQ is set, and refunds when Soliq is unavailable', async () => {
    mocks.env.CAPTURE_COUNT_SOLIQ = true;
    vi.stubGlobal('fetch', vi.fn(async () => upstream()));
    expect((await captureSoliq('user', url)).quota.used).toBe(2);
    expect(mocks.reserve).toHaveBeenCalledOnce();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(captureSoliq('user', url)).rejects.toMatchObject({ statusCode: 502, code: 'soliq_unavailable' });
    expect(mocks.refund).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith({ statusCode: 500 }, 'capture.soliq_failed');
  });

  it('rejects a malformed URL before quota, cache or network', async () => {
    mocks.env.CAPTURE_COUNT_SOLIQ = true;
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(captureSoliq('user', 'https://evil.example/epi?t=1')).rejects.toMatchObject({ statusCode: 400, code: 'invalid_soliq_url' });
    expect(request).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.cached).not.toHaveBeenCalled();
  });

  it('serves a cached receipt without the signing key or the network', async () => {
    mocks.env.SOLIQ_OFD_SIGNING_KEY = '';
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    mocks.cached.mockResolvedValue(receipt());
    const result = await captureSoliq('user', url);
    expect(request).not.toHaveBeenCalled();
    expect(result.drafts[0].amount).toBe(40000);
    mocks.env.SOLIQ_OFD_SIGNING_KEY = 'synthetic-key';
  });

  it('applies the configured amount divisor to every money field', async () => {
    mocks.env.SOLIQ_AMOUNT_DIVISOR = 100;
    vi.stubGlobal('fetch', vi.fn(async () => upstream({ cardTotal: 4000000,
      paymentDetails: [item({ goodPrice: 4000000, price: 4000000 })] })));
    const result = await captureSoliq('user', url);
    mocks.env.SOLIQ_AMOUNT_DIVISOR = 1;
    expect(result.receipt).toMatchObject({ total: 40000, items: [{ price: 40000, amount: 40000 }] });
  });

  it('sends the timestamp in Unix seconds', async () => {
    const request = vi.fn(async () => upstream());
    vi.stubGlobal('fetch', request);
    await captureSoliq('user', url);
    const sent = (request.mock.calls[0] as any)[1].headers['X-Timestamp'];
    expect(sent).toMatch(/^\d{10}$/);
  });

  it('turns a refund receipt into an income draft with the category left to the user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream({ isRefund: 1 })));
    const result = await captureSoliq('user', url);
    expect(result.receipt.isRefund).toBe(true);
    expect(result.drafts[0]).toMatchObject({ type: 'income', categoryId: null, categoryConfidence: 'low' });
    expect(result.drafts[0].lowConfidenceFields).toContain('category');
  });

  it('marks the amount low (not an error) when the paid lines do not add up to the total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream({ cardTotal: 55000 })));
    const result = await captureSoliq('user', url);
    expect(result.drafts[0]).toMatchObject({ amount: 55000 });
    expect(result.drafts[0].lowConfidenceFields).toContain('amount');
  });
});

describe('voice and photo quota', () => {
  it('counts a recognition, and gives the slot back when nothing was recognised', async () => {
    mocks.transcribe.mockResolvedValue('кофе 25 минг'); mocks.parse.mockResolvedValue([{ draftId: 'd' }]);
    expect((await captureVoice('user', Buffer.from('x'), 'audio/mp4')).quota.used).toBe(2);
    expect(mocks.refund).not.toHaveBeenCalled();
    mocks.transcribe.mockResolvedValue('');
    expect((await captureVoice('user', Buffer.from('x'), 'audio/mp4')).quota.used).toBe(1);
    expect(mocks.refund).toHaveBeenCalledOnce();
    mocks.transcribe.mockResolvedValue('tomorrow is sunny'); mocks.parse.mockResolvedValue([]);
    expect((await captureVoice('user', Buffer.from('x'), 'audio/mp4')).drafts).toEqual([]);
    expect(mocks.refund).toHaveBeenCalledTimes(2);
  });

  it('stops refunding empty results after the daily allowance and for a photo that is not a receipt', async () => {
    mocks.allowance.mockResolvedValue(false);
    mocks.transcribe.mockResolvedValue(''); mocks.parse.mockResolvedValue([]);
    expect((await captureVoice('user', Buffer.from('x'), 'audio/mp4')).quota.used).toBe(2);
    expect(mocks.refund).not.toHaveBeenCalled();
    mocks.allowance.mockResolvedValue(true);
    const { AppError } = await import('../../src/utils/AppError');
    mocks.photo.mockRejectedValue(new AppError(422, 'not_a_receipt'));
    await expect(capturePhoto('user', Buffer.from('x'))).rejects.toMatchObject({ code: 'not_a_receipt' });
    expect(mocks.refund).toHaveBeenCalledOnce();
  });

  it('does not charge a client that disconnected before the answer', async () => {
    mocks.transcribe.mockResolvedValue('x'); mocks.parse.mockResolvedValue([{}]);
    const controller = new AbortController();
    mocks.parse.mockImplementation(async () => { controller.abort(); return [{}]; });
    expect((await captureVoice('user', Buffer.from('x'), 'audio/mp4', undefined, undefined, controller.signal)).quota.used).toBe(1);
    expect(mocks.refund).toHaveBeenCalledOnce();
  });

  it('rejects at the limit before any model call and refunds failed model work exactly once', async () => {
    mocks.reserve.mockResolvedValue(false); mocks.usage.mockResolvedValue(5);
    await expect(captureVoice('user', Buffer.from('x'), 'audio/mp4')).rejects.toMatchObject({
      statusCode: 402, code: 'capture_quota_exceeded', details: { quota: { used: 5, limit: 5 } } });
    expect(mocks.transcribe).not.toHaveBeenCalled();
    mocks.reserve.mockResolvedValue(true);
    mocks.photo.mockRejectedValue(new Error('provider down'));
    await expect(capturePhoto('user', Buffer.from('x'))).rejects.toThrow('provider down');
    expect(mocks.refund).toHaveBeenCalledOnce();
  });

  it('uses the Premium cap of 300', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.transcribe.mockResolvedValue('x'); mocks.parse.mockResolvedValue([{}]);
    expect((await captureVoice('user', Buffer.from('x'), 'audio/mp4')).quota).toMatchObject({ limit: 300, premium: true });
    expect(mocks.reserve).toHaveBeenCalledWith('user', expect.any(String), 300);
  });
});

describe('model context', () => {
  it('sends only own, personal, categorised history and the user timezone and language', async () => {
    mocks.rows.cards = [{ id: 'c1', name: 'Humo', currency: 'UZS' }, { id: 'c2', name: 'Shared', scope: 'household' }];
    mocks.rows.transactions = [
      { id: 't1', comment: 'Synthetic cafe', categoryId: food.id, capture: { merchantTin: '123456789' } },
      { id: 't2', comment: 'transfer', categoryId: '', source: 'transfer' },
      { id: 't3', comment: 'family', categoryId: food.id, scope: 'household' },
      { id: 't4', comment: '', categoryId: food.id },
    ];
    mocks.profile.mockResolvedValue({ language: 'en', timezone: 'Asia/Samarkand' });
    const result = await captureContext('user');
    expect(result.accounts).toEqual([{ id: 'c1', name: 'Humo', currency: 'UZS' }]);
    expect(result.recent).toEqual([{ comment: 'Synthetic cafe', categoryId: food.id }]);
    expect(result.merchantNames).toEqual(['merchant-123456789']);
    expect(result).toMatchObject({ language: 'en', timezone: 'Asia/Samarkand' });
    expect((await captureContext('user', 'not/azone')).timezone).toBe('Asia/Tashkent');
  });
});
