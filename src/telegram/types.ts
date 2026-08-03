import type { Card, Category, Currency, Subcategory, TransactionType } from '../domain/types';

export type SupportedLanguage = 'en' | 'ru' | 'uz';

export type DraftReason =
  | 'AMBIGUOUS_SMALL_AMOUNT'
  | 'AMOUNT_MISMATCH'
  | 'LOW_AMOUNT_CONFIDENCE'
  | 'NO_CATEGORY_MATCH'
  | 'LOW_CATEGORY_CONFIDENCE'
  | 'INSUFFICIENT_FUNDS'
  | 'NO_CARD_IN_CURRENCY'
  | 'AMBIGUOUS_CARD_HINT'
  | 'NO_CARDS'
  | 'DATE_IN_FUTURE'
  | 'AMBIGUOUS_TYPE'
  | 'FX_UNAVAILABLE';

export interface ParsedItem {
  rawText: string;
  type: TransactionType;
  amount: number;
  amountLiteral: string;
  currency: Currency;
  categoryId: string;
  categoryConfidence: number;
  suggestedCategoryName: string;
  suggestedCategoryIcon: string;
  subcategoryId: string;
  comment: string;
  dateISO: string;
  cardHint: string;
  amountConfidence: number;
  typeConfidence: number;
  notes: string;
}

export interface ResolveCatalog {
  categories: Category[];
  subcategories: Subcategory[];
  cards: Card[];
  recentCardIds: string[];
}
