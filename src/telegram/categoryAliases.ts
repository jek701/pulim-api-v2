import type { SupportedLanguage } from './types';
import type { Category } from '../domain/types';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories';

export const CATEGORY_ALIASES: Record<string, Record<SupportedLanguage, string>> = {
  Salary: { en: 'Salary', ru: 'Зарплата', uz: 'Maosh' },
  Freelance: { en: 'Freelance', ru: 'Фриланс', uz: 'Frilans' },
  Investments: { en: 'Investments', ru: 'Инвестиции', uz: 'Investitsiyalar' },
  Gift: { en: 'Gift', ru: 'Подарки', uz: 'Sovg‘alar' },
  Business: { en: 'Business', ru: 'Бизнес', uz: 'Biznes' },
  'Other Income': { en: 'Other income', ru: 'Другие доходы', uz: 'Boshqa daromadlar' },
  Food: { en: 'Food', ru: 'Еда', uz: 'Oziq-ovqat' },
  Transport: { en: 'Transport', ru: 'Транспорт', uz: 'Transport' },
  Shopping: { en: 'Shopping', ru: 'Покупки', uz: 'Xaridlar' },
  Bills: { en: 'Bills', ru: 'Счета и коммунальные услуги', uz: 'Kommunal to‘lovlar' },
  Entertainment: { en: 'Entertainment', ru: 'Развлечения', uz: 'Ko‘ngilochar' },
  Health: { en: 'Health', ru: 'Здоровье', uz: 'Sog‘liq' },
  Education: { en: 'Education', ru: 'Образование', uz: 'Ta’lim' },
  Housing: { en: 'Housing', ru: 'Жильё', uz: 'Uy-joy' },
  Travel: { en: 'Travel', ru: 'Путешествия', uz: 'Sayohat' },
  Beauty: { en: 'Beauty', ru: 'Красота', uz: 'Go‘zallik' },
  Other: { en: 'Other', ru: 'Другое', uz: 'Boshqa' },
};

export function aliasesForCategory(name: string): string[] {
  const aliases = CATEGORY_ALIASES[name];
  return aliases ? [...new Set(Object.values(aliases))] : [];
}

export function categoryDisplayName(
  category: Pick<Category, 'name' | 'icon' | 'type'>,
  language: SupportedLanguage,
): string {
  const isDefault = DEFAULT_CATEGORIES.some((candidate) => candidate.name === category.name
    && candidate.icon === category.icon && candidate.type === category.type);
  return isDefault ? CATEGORY_ALIASES[category.name]?.[language] ?? category.name : category.name;
}
