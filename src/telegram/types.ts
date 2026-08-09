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
  | 'FX_UNAVAILABLE'
  | 'NO_SOURCE_CARD'
  | 'NO_DESTINATION_CARD'
  | 'AMBIGUOUS_SOURCE_CARD'
  | 'AMBIGUOUS_DESTINATION_CARD'
  | 'TRANSFER_SAME_CARD'
  | 'NO_TO_AMOUNT'
  | 'NO_DEBT_MATCH'
  | 'AMBIGUOUS_DEBT'
  | 'DEBT_ALREADY_PAID'
  | 'DEBT_PAYMENT_TOO_LARGE'
  | 'MISSING_PERSON'
  | 'AMBIGUOUS_DEBT_DIRECTION';

export type ParsedOperationKind = 'transaction' | 'transfer' | 'debt' | 'debt_payment';

export interface ParsedItem {
  rawText: string;
  kind: ParsedOperationKind;
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
  fromCardHint: string;
  toCardHint: string;
  toAmount: number;
  toAmountLiteral: string;
  toCurrency: Currency;
  debtId: string;
  person: string;
  debtDirection: 'i_owe' | 'owe_me' | '';
  commissionType: 'percent' | 'fixed' | '';
  commissionValue: number;
  dueDateISO: string;
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
