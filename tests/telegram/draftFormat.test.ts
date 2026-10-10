import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/firebase', () => ({ db: {}, auth: {}, Timestamp: {}, FieldValue: {} }));

const { formatDraftOperation } = await import('../../src/telegram/quickEntry.service');

const catalog = {
  categories: [{ id: 'food', name: 'Food', icon: '🍔', color: '#000', type: 'expense' as const, userId: 'u1', createdAt: 0 }],
  subcategories: [],
  cards: [{ id: 'humo', name: 'Humo', bank: '', cardType: 'debit' as const, currency: 'UZS' as const, balance: 0, userId: 'u1', createdAt: 0 }],
};
const draft = { type: 'expense', amount: 125_000, currency: 'UZS', categoryId: 'food', comment: 'Korzinka', date: Date.UTC(2026, 9, 9) };

describe('formatDraftOperation', () => {
  it('never claims a card-less draft is already saved', () => {
    const text = formatDraftOperation('transaction', draft, catalog, 'ru', ['NO_CARDS']);

    expect(text).not.toContain('сохранена');
    expect(text).toContain('Проверьте');
    expect(text).toContain('Еда');
    expect(text).toContain('Карта не указана.');
  });

  it('keeps the same body for a draft with a card', () => {
    const text = formatDraftOperation('transaction', { ...draft, cardId: 'humo' }, catalog, 'ru', []);

    expect(text).not.toContain('сохранена');
    expect(text).toContain('💳 Карта: Humo');
  });
});
