import type { Card, Currency, TransactionType } from '../../domain/types';
import type { ParsedItem } from '../types';

const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();

export function resolveCard(
  item: Pick<ParsedItem, 'cardHint'>,
  cards: Card[],
  recentCardIds: string[],
  amount: number,
  currency: Currency,
  type: TransactionType,
): {
  cardId: string | undefined;
  ambiguous: boolean;
  reason: 'INSUFFICIENT_FUNDS' | 'NO_CARD_IN_CURRENCY' | 'AMBIGUOUS_CARD_HINT' | 'NO_CARDS' | null;
} {
  if (cards.length === 0) {
    return { cardId: undefined, ambiguous: false, reason: 'NO_CARDS' };
  }
  if (item.cardHint.trim()) {
    const hint = normalize(item.cardHint);
    const matches = cards.filter((card) => normalize(`${card.name} ${card.bank}`).includes(hint));
    if (matches.length === 1) return { cardId: matches[0]!.id, ambiguous: false, reason: null };
    if (matches.length > 1) return { cardId: matches[0]!.id, ambiguous: true, reason: 'AMBIGUOUS_CARD_HINT' };
  }

  const rank = new Map(recentCardIds.map((id, index) => [id, index]));
  const sorted = (items: Card[]) => [...items].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || right.createdAt - left.createdAt;
  });
  const candidates = sorted(cards.filter((card) => card.currency === currency));
  if (candidates.length === 0) {
    return { cardId: sorted(cards)[0]!.id, ambiguous: true, reason: 'NO_CARD_IN_CURRENCY' };
  }
  if (type === 'income') return { cardId: candidates[0]!.id, ambiguous: false, reason: null };

  const sufficient = candidates.find((card) => {
    const available = card.cardType === 'credit' ? (card.limit ?? 0) - card.balance : card.balance;
    return available >= amount;
  });
  return sufficient
    ? { cardId: sufficient.id, ambiguous: false, reason: null }
    : { cardId: candidates[0]!.id, ambiguous: true, reason: 'INSUFFICIENT_FUNDS' };
}
