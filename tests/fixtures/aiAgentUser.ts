import type { AgentFixture } from '../../src/ai/agent/fixtureDataSource';
import type { Transaction, Category, Card } from '../../src/domain/types';
export const fixtureNow = Date.parse('2026-11-09T10:00:00+05:00');
const uid = 'synthetic-agent-user';
const at = (key: string, time = '13:20') => Date.parse(`${key}T${time}:00+05:00`);
const base = { userId: uid, createdAt: at('2025-11-01') };
const names = [
  'Продукты',
  'Кафе и рестораны',
  'Транспорт',
  'Такси',
  'Коммунальные',
  'Связь',
  'Развлечения',
  'Одежда',
  'Здоровье',
  'Подарки',
  'Зарплата',
  'Фриланс',
];
const categories: Category[] = names.map((name, i) => ({
  ...base,
  id: `c${i}`,
  name,
  type: i < 10 ? 'expense' : 'income',
  icon: '•',
  color: '#268573',
}));
let seed = 701;
const rand = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const transactions: Transaction[] = [];
const add = (key: string, amount: number, categoryId: string, extra: Partial<Transaction> = {}) => {
  transactions.push({
    ...base,
    id: `t${transactions.length}`,
    amount,
    currency: 'UZS',
    type: 'expense',
    categoryId,
    cardId: 'uzs',
    date: at(key),
    ...extra,
  });
};
for (let ms = at('2025-11-01'); ms <= at('2026-11-08'); ms += 86400000) {
  const key = new Date(ms + 5 * 3600000).toISOString().slice(0, 10),
    dow = new Date(ms + 5 * 3600000).getUTCDay(),
    dom = Number(key.slice(8));
  const weekend = dow === 0 || dow === 6;
  if (rand() < (weekend ? 0.8 : 0.4))
    add(key, (3 + Math.floor(rand() * 14)) * 10000, 'c0', {
      comment: 'Покупки в Korzinka',
      sourceLabel: 'Korzinka',
    });
  if (rand() < (weekend ? 0.6 : 0.8))
    add(key, (2 + Math.floor(rand() * 9)) * 10000, 'c1', {
      subcategoryId: rand() < 0.45 ? 'coffee' : 'fastfood',
      sourceLabel: rand() < 0.5 ? 'Evos' : 'Safia',
      comment: weekend ? 'Ужин' : 'Обед',
      date: at(key, '19:30'),
    });
  if (!weekend)
    add(key, rand() < 0.3 ? 24000 : 4000, rand() < 0.3 ? 'c3' : 'c2', {
      cardId: 'cash',
      comment: 'Дорога',
    });
  if (dom === 1) add(key, 450000, 'c4');
  if (dom === 5) add(key, 70000, 'c5', { source: 'subscription', sourceLabel: 'Mobile' });
  if (dom === 10)
    add(key, 5, 'c6', {
      currency: 'USD',
      cardId: 'usd',
      ...(rand() < 0.7 ? { baseAmount: 65000 } : {}),
      comment: 'Digital service',
    });
  if (dom === 15) add(key, (2 + Math.floor(rand() * 5)) * 100000, `c${6 + Math.floor(rand() * 4)}`);
  if (dom === 25) add(key, 12000000, 'c10', { type: 'income', comment: 'Зарплата' });
  if (dom === 20)
    add(key, 1500000 + Math.floor(rand() * 4) * 500000, 'c11', {
      type: 'income',
      comment: 'Проект',
    });
  if (dom === 27) add(key, 1000000, '', { source: 'transfer', toCardId: 'cash' });
}
add('2026-09-03', 200000, 'c7', { returnedAmount: 50000, comment: 'Куртка' });
const original1 = transactions[transactions.length - 1].id;
add('2026-09-05', 50000, 'c7', {
  source: 'return',
  type: 'income',
  linkedTransactionId: original1,
});
add('2026-10-29', 300000, 'c0', { returnedAmount: 100000, comment: 'Заказ' });
const original2 = transactions[transactions.length - 1].id;
add('2026-11-02', 100000, 'c0', {
  source: 'return',
  type: 'income',
  linkedTransactionId: original2,
});
for (const key of ['2026-09-10', '2026-10-04', '2026-11-01'])
  add(key, 900000, 'c0', { scope: 'household' });
const accounts: Card[] = [
  {
    ...base,
    id: 'uzs',
    name: 'UZCARD',
    bank: 'Bank',
    cardType: 'debit',
    currency: 'UZS',
    balance: 18000000,
  },
  {
    ...base,
    id: 'usd',
    name: 'Visa USD',
    bank: 'Bank',
    cardType: 'debit',
    currency: 'USD',
    balance: 250,
  },
  {
    ...base,
    id: 'cash',
    name: 'Наличные',
    bank: '',
    cardType: 'cash',
    currency: 'UZS',
    balance: 1200000,
  },
];
export const aiAgentUser: AgentFixture = {
  profile: {
    ...base,
    salarySources: [{ name: 'Основная работа', day: 25, amount: 12000000 }],
    financialGoals: ['emergency_fund'],
  } as AgentFixture['profile'],
  transactions,
  categories,
  accounts,
  subcategories: [
    { ...base, id: 'coffee', categoryId: 'c1', name: 'Кофе' },
    { ...base, id: 'fastfood', categoryId: 'c1', name: 'Фастфуд' },
  ],
  budgets: [
    {
      ...base,
      id: 'b0',
      categoryId: 'c0',
      amount: 3000000,
      currency: 'UZS',
      updatedAt: fixtureNow,
    },
    {
      ...base,
      id: 'b1',
      categoryId: 'c1',
      amount: 2000000,
      currency: 'UZS',
      updatedAt: fixtureNow,
    },
    {
      ...base,
      id: 'bi',
      categoryId: '__income__',
      amount: 14000000,
      currency: 'UZS',
      updatedAt: fixtureNow,
    },
  ],
  subscriptions: ['Mobile', 'Internet', 'Music', 'Gym'].map((name, i) => ({
    ...base,
    id: `s${i}`,
    name,
    icon: '•',
    currency: 'UZS',
    amount: [70000, 150000, 30000, 300000][i],
    cycle: 'monthly',
    nextBillingDate: at(`2026-11-${[10, 12, 15, 20][i]}`),
    isActive: true,
  })),
  plannedExpenses: [
    {
      ...base,
      id: 'pe',
      name: 'Аренда',
      amount: 3000000,
      currency: 'UZS',
      icon: '•',
      recurrence: 'monthly',
      dayOfMonth: 15,
    },
    {
      ...base,
      id: 'pi',
      name: 'Бонус',
      amount: 500000,
      currency: 'UZS',
      icon: '•',
      kind: 'income',
      recurrence: 'once',
      date: at('2026-11-18'),
    },
  ],
  debts: [
    {
      ...base,
      id: 'd0',
      person: 'Азиз',
      direction: 'i_owe',
      amount: 2000000,
      paidAmount: 500000,
      currency: 'UZS',
      isPaid: false,
      dueDate: at('2026-11-20'),
    },
    {
      ...base,
      id: 'd1',
      person: 'Анна',
      direction: 'owe_me',
      amount: 1000000,
      paidAmount: 200000,
      currency: 'UZS',
      isPaid: false,
      dueDate: at('2026-11-22'),
    },
  ],
  savingsGoals: [
    {
      ...base,
      id: 'g0',
      name: 'Резерв',
      icon: '•',
      targetAmount: 30000000,
      savedAmount: 12000000,
      currency: 'UZS',
      deadline: at('2027-11-09'),
    },
    {
      ...base,
      id: 'g1',
      name: 'Отпуск',
      icon: '•',
      targetAmount: 15000000,
      savedAmount: 5000000,
      currency: 'UZS',
      deadline: at('2027-06-09'),
    },
  ],
};
