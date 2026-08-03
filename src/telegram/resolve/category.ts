import type { Category, Subcategory } from '../../domain/types';
import { aliasesForCategory } from '../categoryAliases';
import type { ParsedItem, SupportedLanguage } from '../types';
import { DEFAULT_CATEGORIES } from '../../domain/defaultCategories';

const normalize = (value: string) => value
  .toLocaleLowerCase()
  .replace(/[ʻ‘'’-]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export function resolveCategory(
  item: ParsedItem,
  categories: Category[],
  subcategories: Subcategory[],
  _language: SupportedLanguage,
): {
  categoryId: string;
  subcategoryId?: string;
  ambiguous: boolean;
  reason: 'NO_CATEGORY_MATCH' | 'LOW_CATEGORY_CONFIDENCE' | null;
} {
  const compatible = (category: Category) => category.type === item.type || category.type === 'both';
  let selected = categories.find((category) => category.id === item.categoryId && compatible(category));
  let ambiguous = false;
  let reason: 'NO_CATEGORY_MATCH' | 'LOW_CATEGORY_CONFIDENCE' | null = null;

  if (selected && item.categoryConfidence < 0.75) {
    ambiguous = true;
    reason = 'LOW_CATEGORY_CONFIDENCE';
  }
  if (!selected) {
    const haystack = normalize(`${item.rawText} ${item.comment}`);
    const namesFor = (category: Category) => {
      const isDefault = DEFAULT_CATEGORIES.some((candidate) => candidate.name === category.name
        && candidate.icon === category.icon && candidate.type === category.type);
      return [category.name, ...(isDefault ? aliasesForCategory(category.name) : [])];
    };
    const matches = categories.filter((category) => compatible(category) && [
      ...namesFor(category),
    ].some((name) => haystack.includes(normalize(name))));
    if (matches.length === 1) selected = matches[0];
  }
  if (!selected) {
    return { categoryId: '', ambiguous: true, reason: 'NO_CATEGORY_MATCH' };
  }

  const subcategory = subcategories.find(
    (candidate) => candidate.id === item.subcategoryId && candidate.categoryId === selected.id,
  );
  return {
    categoryId: selected.id,
    ...(subcategory ? { subcategoryId: subcategory.id } : {}),
    ambiguous,
    reason,
  };
}
