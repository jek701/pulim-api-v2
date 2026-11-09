export type LanguageCode = 'uz' | 'ru' | 'en';
export interface AgentStatus {
  stage: 'thinking' | 'tool' | 'writing';
  tool?: string;
  label?: string;
}
export const resolveLanguageCode = (language: string): LanguageCode =>
  /^(ru|russian)/i.test(language) ? 'ru' : /^(uz|uzbek)/i.test(language) ? 'uz' : 'en';
const toolLabels: Record<LanguageCode, Record<string, string>> = {
  ru: {
    get_spending_stats: 'Считаю траты',
    find_transactions: 'Ищу операции',
    get_budgets_status: 'Проверяю бюджеты',
    get_upcoming: 'Проверяю предстоящие платежи',
    calculate: 'Считаю',
    get_transactions_digest: 'Изучаю операции',
  },
  uz: {
    get_spending_stats: 'Xarajatlarni hisoblayapman',
    find_transactions: 'Operatsiyalarni qidiryapman',
    get_budgets_status: 'Budjetlarni tekshiryapman',
    get_upcoming: 'Kelgusi to‘lovlarni tekshiryapman',
    calculate: 'Hisoblayapman',
    get_transactions_digest: 'Operatsiyalarni ko‘rib chiqyapman',
  },
  en: {
    get_spending_stats: 'Calculating spending',
    find_transactions: 'Finding transactions',
    get_budgets_status: 'Checking budgets',
    get_upcoming: 'Checking upcoming payments',
    calculate: 'Calculating',
    get_transactions_digest: 'Reviewing transactions',
  },
};
export function statusLabel(tool: string, raw: string, language: LanguageCode): string {
  let period = '';
  try {
    const a = JSON.parse(raw),
      f = a.filters;
    const short = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
    if (f && /^\d{4}-\d{2}-\d{2}$/.test(f.date_from) && /^\d{4}-\d{2}-\d{2}$/.test(f.date_to))
      period = ` · ${short(f.date_from)}–${short(f.date_to)}`;
    else if (/^\d{4}-\d{2}$/.test(a.month)) period = ` · ${a.month}`;
  } catch {
    /* Invalid args are reported by the handler. */
  }
  return (toolLabels[language][tool] ?? toolLabels[language].calculate) + period;
}
const suggestions: Record<LanguageCode, Record<string, string[]>> = {
  ru: {
    stats: ['Сравни с предыдущим периодом', 'Покажи самые крупные траты за этот период'],
    budgets: ['На чём я могу сэкономить?'],
    upcoming: ['Хватит ли денег до зарплаты?'],
    none: ['Какая категория самая большая в этом месяце?', 'Как сократить расходы?'],
  },
  uz: {
    stats: ['Oldingi davr bilan solishtir', 'Shu davrdagi eng katta xarajatlarni ko‘rsat'],
    budgets: ['Qayerda tejashim mumkin?'],
    upcoming: ['Maoshgacha pulim yetadimi?'],
    none: ['Bu oy eng katta xarajat qaysi toifada?', 'Xarajatlarni qanday kamaytirsam bo‘ladi?'],
  },
  en: {
    stats: ['Compare with the previous period', 'Show the biggest expenses in this period'],
    budgets: ['Where can I save?'],
    upcoming: ['Will my money last until payday?'],
    none: ['What is my biggest category this month?', 'How can I cut costs?'],
  },
};
export function chooseFollowups(tools: string[], language: LanguageCode): string[] {
  const keys = [
    ...(tools.some((t) =>
      ['get_spending_stats', 'find_transactions', 'get_transactions_digest'].includes(t),
    )
      ? ['stats']
      : []),
    ...(tools.includes('get_budgets_status') ? ['budgets'] : []),
    ...(tools.includes('get_upcoming') ? ['upcoming'] : []),
  ];
  return [
    ...new Set((keys.length ? keys : ['none']).flatMap((k) => suggestions[language][k])),
  ].slice(0, 3);
}
