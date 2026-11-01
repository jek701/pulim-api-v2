import { createHash } from 'node:crypto';
import type { CategoryType } from './types';

// Mirrors the app defaults (names, icons, colors). Purple is deliberately absent (redesign
// palette "Mint"); existing users' stored category rows keep the colors they were seeded with.
export const DEFAULT_CATEGORIES: { name: string; icon: string; color: string; type: CategoryType }[] = [
  { name: 'Salary', icon: '💼', color: '#30D158', type: 'income' },
  { name: 'Freelance', icon: '💻', color: '#0A84FF', type: 'income' },
  { name: 'Investments', icon: '📈', color: '#8BC34A', type: 'income' },
  { name: 'Gift', icon: '🎁', color: '#FF8A65', type: 'income' },
  { name: 'Business', icon: '🏪', color: '#FF9F0A', type: 'income' },
  { name: 'Other Income', icon: '💰', color: '#5AC8FA', type: 'income' },
  { name: 'Food', icon: '🍔', color: '#FF9F0A', type: 'expense' },
  { name: 'Transport', icon: '🚗', color: '#5AC8FA', type: 'expense' },
  { name: 'Shopping', icon: '🛍️', color: '#FF375F', type: 'expense' },
  { name: 'Bills', icon: '💡', color: '#FF453A', type: 'expense' },
  { name: 'Entertainment', icon: '🎮', color: '#A6D44B', type: 'expense' },
  { name: 'Health', icon: '🏥', color: '#30D158', type: 'expense' },
  { name: 'Education', icon: '📚', color: '#0A84FF', type: 'expense' },
  { name: 'Housing', icon: '🏠', color: '#A2845E', type: 'expense' },
  { name: 'Travel', icon: '✈️', color: '#FFD60A', type: 'expense' },
  { name: 'Beauty', icon: '💈', color: '#FF8A65', type: 'expense' },
  { name: 'Other', icon: '📦', color: '#636366', type: 'expense' },
];

// Matches the frontend slug + deterministic id scheme so seeding stays idempotent
// across client and server (`useCategories.ts`).
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const defaultCategoryId = (uid: string, type: CategoryType, name: string) =>
  `${uid}__default__${type}_${slugify(name)}`;

/** Calm default color for an onboarding custom category that arrives without one. */
export const CUSTOM_CATEGORY_DEFAULT_COLOR = '#8E8E93';

export const ONBOARDING_MAX_CUSTOM_CATEGORIES = 10;
export const ONBOARDING_NAME_MAX = 40;
export const ONBOARDING_ICON_MAX = 32;

export type OnboardingCategoryType = 'income' | 'expense';

/** Optional first-run selection accepted by `POST /v1/profile/bootstrap`. */
export interface OnboardingCategorySelection {
  categories: {
    defaults: { type: OnboardingCategoryType; name: string }[];
    custom: { type: OnboardingCategoryType; name: string; icon: string; color?: string }[];
  };
}

/** Case/whitespace-insensitive name used for ids and duplicate detection. */
export const normalizeCategoryName = (name: string) =>
  name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Deterministic id of an onboarding custom category: same uid + type + normalized name
 * always maps to the same document, so a retried bootstrap never duplicates. Contains `__`
 * (like every non-client id) so a client can never claim it through `POST /categories`, and
 * it does not use the `__default__` marker, so the category stays "custom" for edit rules.
 * Hash-based because names may be Cyrillic/Uzbek, which the ASCII slug would erase.
 */
export const customCategoryId = (uid: string, type: CategoryType, name: string) =>
  `${uid}__onboarding__${type}_${createHash('sha256').update(normalizeCategoryName(name)).digest('hex').slice(0, 16)}`;

export interface CategorySeed {
  id: string;
  data: { name: string; icon: string; color: string; type: CategoryType; userId: string; createdAt: number };
}

/**
 * Expands the (already validated) selection into documents. Without a selection: every
 * default, exactly as before. Duplicates (same type + normalized name) collapse to the first
 * occurrence; a custom entry that repeats a chosen default is dropped.
 */
export function categorySeeds(
  uid: string,
  createdAt: number,
  selection?: OnboardingCategorySelection,
): CategorySeed[] {
  const seeds: CategorySeed[] = [];
  const seen = new Set<string>();
  const add = (id: string, cat: { name: string; icon: string; color: string; type: CategoryType }) => {
    const dedupe = `${cat.type}\0${normalizeCategoryName(cat.name)}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    seeds.push({ id, data: { ...cat, userId: uid, createdAt } });
  };
  if (!selection) {
    for (const cat of DEFAULT_CATEGORIES) add(defaultCategoryId(uid, cat.type, cat.name), cat);
    return seeds;
  }
  for (const chosen of selection.categories.defaults) {
    const cat = DEFAULT_CATEGORIES.find((c) => c.type === chosen.type && c.name === chosen.name);
    if (cat) add(defaultCategoryId(uid, cat.type, cat.name), cat);
  }
  for (const custom of selection.categories.custom) {
    add(customCategoryId(uid, custom.type, custom.name), {
      name: custom.name,
      icon: custom.icon,
      color: custom.color ?? CUSTOM_CATEGORY_DEFAULT_COLOR,
      type: custom.type,
    });
  }
  return seeds;
}
