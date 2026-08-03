import { describe, expect, it } from 'vitest';
import type { Category, Subcategory } from '../../src/domain/types';
import type { ParsedItem } from '../../src/telegram/types';
import { resolveCategory } from '../../src/telegram/resolve/category';

const category = (patch: Partial<Category> = {}): Category => ({
  id: 'food', name: 'Food', icon: '🍔', color: '#fff', type: 'expense',
  userId: 'u', createdAt: 1, ...patch,
});
const item = (patch: Partial<ParsedItem> = {}): ParsedItem => ({
  rawText: 'обед 45к', type: 'expense', amount: 45_000, amountLiteral: '45к',
  currency: 'UZS', categoryId: 'food', categoryConfidence: 1,
  suggestedCategoryName: '', suggestedCategoryIcon: '', subcategoryId: '', comment: 'Обед',
  dateISO: '', cardHint: '', amountConfidence: 1, typeConfidence: 1, notes: '', ...patch,
});

describe('resolveCategory', () => {
  it('accepts a compatible catalog id', () => {
    expect(resolveCategory(item(), [category()], [], 'ru').categoryId).toBe('food');
  });

  it('rejects an incompatible type', () => {
    expect(resolveCategory(item({ type: 'income', rawText: 'неизвестно' }), [category()], [], 'ru').reason)
      .toBe('NO_CATEGORY_MATCH');
  });

  it('matches a default Russian alias', () => {
    expect(resolveCategory(item({ categoryId: '', rawText: 'еда 45к' }), [category()], [], 'ru').categoryId)
      .toBe('food');
  });

  it('matches a default Uzbek alias', () => {
    expect(resolveCategory(item({ categoryId: '', rawText: 'oziq-ovqat 45 ming' }), [category()], [], 'uz').categoryId)
      .toBe('food');
  });

  it('does not attach default aliases to a custom lookalike', () => {
    const custom = category({ id: 'custom', icon: '☕' });
    expect(resolveCategory(item({ categoryId: '', rawText: 'еда 45к', comment: '' }), [custom], [], 'ru').categoryId)
      .toBe('');
  });

  it('marks low model confidence', () => {
    expect(resolveCategory(item({ categoryConfidence: 0.5 }), [category()], [], 'ru').reason)
      .toBe('LOW_CATEGORY_CONFIDENCE');
  });

  it('keeps only a subcategory owned by the chosen category', () => {
    const sub: Subcategory = { id: 'lunch', name: 'Lunch', categoryId: 'food', userId: 'u', createdAt: 1 };
    expect(resolveCategory(item({ subcategoryId: 'lunch' }), [category()], [sub], 'en').subcategoryId).toBe('lunch');
    expect(resolveCategory(item({ subcategoryId: 'other' }), [category()], [sub], 'en').subcategoryId).toBeUndefined();
  });
});
