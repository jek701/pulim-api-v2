import type { CategoryType } from './types';

// Ported verbatim from the frontend `src/utils/defaultCategories.ts`.
export const DEFAULT_CATEGORIES: { name: string; icon: string; color: string; type: CategoryType }[] = [
  { name: 'Salary', icon: '💼', color: '#30D158', type: 'income' },
  { name: 'Freelance', icon: '💻', color: '#0A84FF', type: 'income' },
  { name: 'Investments', icon: '📈', color: '#5E5CE6', type: 'income' },
  { name: 'Gift', icon: '🎁', color: '#BF5AF2', type: 'income' },
  { name: 'Business', icon: '🏪', color: '#FF9F0A', type: 'income' },
  { name: 'Other Income', icon: '💰', color: '#5AC8FA', type: 'income' },
  { name: 'Food', icon: '🍔', color: '#FF9F0A', type: 'expense' },
  { name: 'Transport', icon: '🚗', color: '#5AC8FA', type: 'expense' },
  { name: 'Shopping', icon: '🛍️', color: '#FF375F', type: 'expense' },
  { name: 'Bills', icon: '💡', color: '#FF453A', type: 'expense' },
  { name: 'Entertainment', icon: '🎮', color: '#BF5AF2', type: 'expense' },
  { name: 'Health', icon: '🏥', color: '#30D158', type: 'expense' },
  { name: 'Education', icon: '📚', color: '#0A84FF', type: 'expense' },
  { name: 'Housing', icon: '🏠', color: '#5E5CE6', type: 'expense' },
  { name: 'Travel', icon: '✈️', color: '#FFD60A', type: 'expense' },
  { name: 'Beauty', icon: '💈', color: '#FF375F', type: 'expense' },
  { name: 'Other', icon: '📦', color: '#636366', type: 'expense' },
];

// Matches the frontend slug + deterministic id scheme so seeding stays idempotent
// across client and server (`useCategories.ts`).
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const defaultCategoryId = (uid: string, type: CategoryType, name: string) =>
  `${uid}__default__${type}_${slugify(name)}`;
