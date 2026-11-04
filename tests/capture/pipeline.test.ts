import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../../src/domain/defaultCategories';
const mocks = vi.hoisted(() => ({ transcribe: vi.fn(), respond: vi.fn(), usage: vi.fn(async () => undefined) }));
vi.mock('../../src/config/env', () => ({ env: { TELEGRAM_TRANSCRIBE_MODEL: 'test', TELEGRAM_PARSE_MODEL: 'test', TELEGRAM_RECEIPT_MODEL: 'test' } }));
vi.mock('../../src/services/ai.service', () => ({
  openai: () => ({ audio: { transcriptions: { create: mocks.transcribe } }, responses: { create: mocks.respond } }),
  stableUserHash: () => 'synthetic-user-hash', normalizeUsage: () => null, recordAiUsage: mocks.usage,
}));
import { voiceDraft, parseCaptureVoice, extractCapturePhoto, modelContext, transcribeCapture, type CaptureContext } from '../../src/capture/models';
const categories = DEFAULT_CATEGORIES.map(c => ({ ...c, id: defaultCategoryId('user', c.type, c.name), userId: 'user', createdAt: 0 }));
const context: CaptureContext = { categories, accounts: [{ id: 'cash', name: 'Cash', currency: 'UZS' }],
  recent: [{ comment: 'Synthetic Cafe', categoryId: 'food' }], merchantNames: ['Synthetic Market'],
  now: new Date('2026-11-04T12:00:00Z'), timezone: 'Asia/Tashkent' };
const operation = { type: 'expense' as const, amountSpan: '25 минг', amount: 25000, currency: 'UZS',
  categoryId: categories.find(c => c.name === 'Food')!.id, categoryConfidence: 'high' as const,
  accountMentioned: false, accountId: null, date: '2026-11-04T17:00:00+05:00', dateConfidence: 'high' as const, comment: 'кофе' };
beforeEach(() => vi.clearAllMocks());
describe('deterministic final draft and honest confidence', () => {
  it('ignores model arithmetic and flags disagreement', () => {
    const draft = voiceDraft({ ...operation, amount: 25 }, 'кофе 25 минг', context);
    expect(draft.amount).toBe(25000);
    expect(draft.lowConfidenceFields).toEqual(['amount']);
    expect(draft.draftId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('requires a literal source span: a paraphrase falls back to the one amount actually spoken, flagged', () => {
    const draft = voiceDraft(operation, 'кофе 30 минг', context);
    expect(draft.amount).toBe(30000);
    expect(draft.lowConfidenceFields).toContain('amount');
    const ambiguous = voiceDraft(operation, 'кофе 30 минг и чай 5 минг', context);
    expect(ambiguous.amount).toBe(0);
    expect(ambiguous.lowConfidenceFields).toContain('amount');
  });
  it('flags an account only when one was named but cannot be resolved', () => {
    expect(voiceDraft(operation, 'кофе 25 минг', context)).toMatchObject({ accountId: null, lowConfidenceFields: [] });
    expect(voiceDraft({ ...operation, accountMentioned: true, accountId: 'cash' }, 'кофе 25 минг наличными', context))
      .toMatchObject({ accountId: 'cash', lowConfidenceFields: [] });
    expect(voiceDraft({ ...operation, accountMentioned: true, accountId: 'nope' }, 'кофе 25 минг', context))
      .toMatchObject({ accountId: null, lowConfidenceFields: ['account'] });
    expect(voiceDraft({ ...operation, accountMentioned: false, accountId: 'cash' }, 'кофе 25 минг', context).accountId).toBeNull();
  });
  it('clears low-confidence, foreign-owner, and incompatible categories/accounts', () => {
    for (const change of [{ categoryConfidence: 'low' as const }, { categoryId: 'foreign-category' }, { categoryId: categories.find(c => c.name === 'Salary')!.id }]) {
      const draft = voiceDraft({ ...operation, ...change, accountMentioned: true, accountId: 'foreign-card' }, '25 минг', context);
      expect(draft.categoryId).toBeNull();
      expect(draft.accountId).toBeNull();
      expect(draft.lowConfidenceFields).toEqual(expect.arrayContaining(['category', 'account']));
    }
  });
  it('keeps the spoken small amount and marks omitted thousands/date as uncertain', () => {
    const draft = voiceDraft({ ...operation, amountSpan: '45', amount: 45000, date: '', dateConfidence: 'low' }, 'обед 45', context);
    expect(draft.amount).toBe(45);
    expect(draft.lowConfidenceFields).toEqual(expect.arrayContaining(['amount', 'date']));
    expect(draft.date).toBe('2026-11-04T17:00:00+05:00');
  });
  it('keeps the real time for today but honours an explicitly stated other day', () => {
    expect(voiceDraft({ ...operation, date: '2026-11-04T00:00:00+05:00' }, '25 минг', context).date).toBe('2026-11-04T17:00:00+05:00');
    expect(voiceDraft({ ...operation, date: '2026-11-03T09:30:00+05:00' }, 'вчера 25 минг', context).date).toBe('2026-11-03T09:30:00+05:00');
  });
  it('passes timezone, account catalog, aliases, and history as untrusted model context', () => {
    const result = JSON.parse(modelContext(context));
    expect(result.today).toBe('2026-11-04T17:00:00+05:00');
    expect(result.categories.find((c: any) => c.name === 'Food').aliases).toContain('Еда');
    expect(result.accounts).toEqual(context.accounts);
    expect(result.recentCommentCategories).toEqual(context.recent);
  });
  it('supports several operations without a transaction write, with strict non-stored Responses', async () => {
    mocks.respond.mockResolvedValue({ status: 'completed', output_text: JSON.stringify({ operations: [operation, { ...operation, amountSpan: '$20', amount: 20, currency: 'USD' }] }) });
    const drafts = await parseCaptureVoice('user', 'кофе 25 минг и $20', context);
    expect(drafts.map(d => [d.amount, d.currency])).toEqual([[25000, 'UZS'], [20, 'USD']]);
    expect(mocks.respond.mock.calls[0][0]).toMatchObject({ store: false,
      text: { format: { type: 'json_schema', strict: true } } });
    // Only the documented structured-output keyword subset, and every property required.
    const schema = mocks.respond.mock.calls[0][0].text.format.schema;
    expect(JSON.stringify(schema)).not.toMatch(/maxLength|minLength|nullable|\$schema/);
    const walk = (node: any) => { if (node?.type === 'object') {
      expect(node.additionalProperties).toBe(false);
      expect(node.required.sort()).toEqual(Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    } if (node?.items) walk(node.items); };
    walk(schema);
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'capture_parse', success: true }));
  });
  it('rejects truncated/provider output rather than accepting partial guesses', async () => {
    mocks.respond.mockResolvedValue({ status: 'incomplete', output_text: '{}' });
    await expect(parseCaptureVoice('user', '25 минг', context)).rejects.toThrow('Incomplete');
  });
  it('hints transcription with the user category and recent merchant names', async () => {
    mocks.transcribe.mockResolvedValue({ text: '25 минг' });
    expect(await transcribeCapture('user', Buffer.from('synthetic'), 'audio/mp4', context, 'uz')).toBe('25 минг');
    const request = mocks.transcribe.mock.calls[0][0];
    // The language is a soft prompt hint only, never the model's `language` parameter.
    expect(request).not.toHaveProperty('language');
    expect(request.prompt).toContain('Synthetic Market');
    expect(request.prompt).toContain('usually Uzbek');
  });
});
describe('photo receipts', () => {
  const photo = { isReceipt: true, merchant: { tin: '123456789', name: 'Synthetic Store', address: 'Synthetic street' },
    date: '2026-11-04T12:00:00+05:00', dateConfidence: 'high', total: 24000, currency: 'UZS', amountConfidence: 'high',
    items: [{ name: 'Milk', quantity: 2, price: 15000, discount: 6000, amount: 24000, ikpu: '00401001001000000' }] };
  it('preserves discounts, validates net totals and generates stable photo keys', async () => {
    mocks.respond.mockResolvedValue({ status: 'completed', output_text: JSON.stringify(photo) });
    const a = await extractCapturePhoto('user', Buffer.from('synthetic'), context);
    const b = await extractCapturePhoto('user', Buffer.from('synthetic'), context);
    expect(a.receipt.receiptKey).toBe(b.receipt.receiptKey);
    expect(a.amountLow).toBe(false);
    expect(a.receipt.items[0]).toMatchObject({ discount: 6000, amount: 24000, categoryId: null });
  });
  it('flags total/item arithmetic disagreement and missing dates', async () => {
    mocks.respond.mockResolvedValue({ status: 'completed', output_text: JSON.stringify({ ...photo, total: 50000, date: '' }) });
    const result = await extractCapturePhoto('user', Buffer.from('synthetic'), context);
    expect(result.amountLow).toBe(true);
    expect(result.dateLow).toBe(true);
  });
  it('rejects buyer fields and scrubs phone/card text in seller/item fields', async () => {
    mocks.respond.mockResolvedValue({ status: 'completed', output_text: JSON.stringify({ ...photo,
      merchant: { ...photo.merchant, name: 'Store +998 90 123 45 67' }, items: [{ ...photo.items[0], name: 'Milk 8600 0000 0000 0000' }] }) });
    const result = await extractCapturePhoto('user', Buffer.from('synthetic'), context);
    expect(JSON.stringify(result)).not.toContain('123 45 67');
    expect(JSON.stringify(result)).not.toContain('8600');
    mocks.respond.mockResolvedValue({ status: 'completed', output_text: JSON.stringify({ ...photo, buyer: 'Synthetic Buyer' }) });
    await expect(extractCapturePhoto('user', Buffer.from('synthetic'), context)).rejects.toThrow();
  });
});
