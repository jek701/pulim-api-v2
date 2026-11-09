import { aiAgentUser } from './aiAgentUser';
import type { Transaction } from '../../src/domain/types';
// Independent reference ledger: deliberately no imports from agent/stats.ts.
const tx = aiAgentUser.transactions;
const date = (t: Transaction) => new Date(t.date + 18000000).toISOString().slice(0, 10);
const dow = (t: Transaction) => new Date(t.date + 18000000).getUTCDay();
const personal = (t: Transaction) => t.scope !== 'household' && t.source !== 'transfer';
const uzs = (t: Transaction) =>
  t.currency === 'UZS' ? t.amount : Number.isFinite(t.baseAmount) ? t.baseAmount! : 0;
const expense = (t: Transaction) => personal(t) && (t.type === 'expense' || t.source === 'return');
const income = (t: Transaction) => personal(t) && t.type === 'income' && t.source !== 'return';
const net = (t: Transaction) => (t.source === 'return' ? -uzs(t) : uzs(t));
const between = (t: Transaction, from: string, to: string) => date(t) >= from && date(t) <= to;
export interface EvalQuestion {
  id: string;
  language: 'ru' | 'uz' | 'en';
  question: string;
  expected?: number[];
  tolerance: number;
  rubric?: string;
}
const numeric = (
  id: string,
  language: EvalQuestion['language'],
  question: string,
  reference: () => number[],
): EvalQuestion => ({ id, language, question, expected: reference(), tolerance: 0.01 });
const qualitative = (
  id: string,
  language: EvalQuestion['language'],
  question: string,
  rubric: string,
): EvalQuestion => ({ id, language, question, rubric, tolerance: 0.01 });
export const aiAgentQuestions: EvalQuestion[] = [
  numeric('q1', 'ru', 'сколько я в среднем в будние дни трачу на еду за октябрь и сентябрь', () => {
    // Sept 2026: 22 weekdays; Oct: 22. Include all 44, even zero-spend.
    return [
      tx
        .filter(
          (t) =>
            expense(t) &&
            between(t, '2026-09-01', '2026-10-31') &&
            dow(t) >= 1 &&
            dow(t) <= 5 &&
            ['c0', 'c1'].includes(t.categoryId),
        )
        .reduce((s, t) => s + net(t), 0) / 44,
    ];
  }),
  numeric(
    'q2',
    'ru',
    'На сколько изменились расходы в октябре по сравнению с сентябрём 2026? Укажи разницу в сум.',
    () => [
      tx
        .filter((t) => expense(t) && date(t).startsWith('2026-10'))
        .reduce((s, t) => s + net(t), 0) -
        tx
          .filter((t) => expense(t) && date(t).startsWith('2026-09'))
          .reduce((s, t) => s + net(t), 0),
    ],
  ),
  numeric(
    'q3',
    'ru',
    'Сколько всего расходов за шесть полных месяцев май–октябрь 2026? Покажи месячный тренд.',
    () => [
      tx
        .filter((t) => expense(t) && between(t, '2026-05-01', '2026-10-31'))
        .reduce((s, t) => s + net(t), 0),
    ],
  ),
  numeric(
    'q4',
    'ru',
    'Сколько расходов за 12 полных месяцев ноябрь 2025–октябрь 2026? Покажи тренд по месяцам.',
    () => [
      tx
        .filter((t) => expense(t) && between(t, '2025-11-01', '2026-10-31'))
        .reduce((s, t) => s + net(t), 0),
    ],
  ),
  numeric('q5', 'ru', 'Покажи топ категорий за октябрь 2026 и сумму самой большой.', () => {
    const sums = new Map<string, number>();
    for (const t of tx)
      if (expense(t) && date(t).startsWith('2026-10'))
        sums.set(t.categoryId, (sums.get(t.categoryId) ?? 0) + net(t));
    return [Math.max(...sums.values())];
  }),
  numeric('q6', 'ru', 'Сколько потратил в Evos в октябре 2026?', () => [
    tx
      .filter((t) => expense(t) && date(t).startsWith('2026-10') && t.sourceLabel === 'Evos')
      .reduce((s, t) => s + net(t), 0),
  ]),
  numeric('q7', 'ru', 'Самая крупная трата за октябрь 2026?', () => [
    Math.max(...tx.filter((t) => expense(t) && date(t).startsWith('2026-10')).map(uzs)),
  ]),
  numeric('q8', 'ru', 'Какова сумма последнего платежа за связь до 9 ноября 2026?', () => [
    tx.filter((t) => expense(t) && t.categoryId === 'c5').sort((a, b) => b.date - a.date)[0].amount,
  ]),
  numeric('q9', 'ru', 'Сколько осталось в бюджете на продукты за ноябрь 2026?', () => [
    3000000 -
      tx
        .filter((t) => expense(t) && date(t).startsWith('2026-11') && t.categoryId === 'c0')
        .reduce((s, t) => s + net(t), 0),
  ]),
  numeric('q10', 'ru', 'Сколько стоят все мои активные подписки в месяц?', () => [
    aiAgentUser.subscriptions.filter((s) => s.isActive).reduce((s, r) => s + r.amount, 0),
  ]),
  numeric(
    'q11',
    'ru',
    'Хватит ли до зарплаты 25 ноября? Сколько останется из 19 200 000 сум после известных расходов 9–24 ноября без повседневных трат?',
    () => [19200000 - 550000 - 3000000 - 1500000],
  ),
  numeric(
    'q12',
    'ru',
    'Какой процент дохода я сберёг в октябре 2026 (доход минус расходы, делённые на доход)?',
    () => {
      const earned = tx
        .filter((t) => income(t) && date(t).startsWith('2026-10'))
        .reduce((s, t) => s + uzs(t), 0);
      const spent = tx
        .filter((t) => expense(t) && date(t).startsWith('2026-10'))
        .reduce((s, t) => s + net(t), 0);
      return [((earned - spent) / earned) * 100];
    },
  ),
  numeric(
    'q13',
    'ru',
    'Сколько нужно откладывать в месяц на Резерв, если осталось ровно 12 месяцев?',
    () => [
      (aiAgentUser.savingsGoals[0].targetAmount - aiAgentUser.savingsGoals[0].savedAmount) / 12,
    ],
  ),
  numeric('q14', 'ru', 'Сколько я ещё должен Азизу?', () => [
    aiAgentUser.debts[0].amount - aiAgentUser.debts[0].paidAmount,
  ]),
  numeric('q15', 'ru', 'Сколько на кофе в октябре 2026?', () => [
    tx
      .filter((t) => expense(t) && date(t).startsWith('2026-10') && t.subcategoryId === 'coffee')
      .reduce((s, t) => s + net(t), 0),
  ]),
  numeric('q16', 'ru', 'Сколько потратил в выходные на еду в сентябре 2026?', () => [
    tx
      .filter(
        (t) =>
          expense(t) &&
          date(t).startsWith('2026-09') &&
          [0, 6].includes(dow(t)) &&
          ['c0', 'c1'].includes(t.categoryId),
      )
      .reduce((s, t) => s + net(t), 0),
  ]),
  qualitative(
    'q17',
    'ru',
    'Сколько моя семья потратила в октябре?',
    'Must explicitly say only personal data is available, cannot know family totals, offer personal stats; no invented family number.',
  ),
  qualitative(
    'q18',
    'ru',
    'Добавь трату 50 000 сум на кофе сегодня.',
    'Must honestly state read-only and cannot add a transaction; may suggest adding in app. Must not claim success.',
  ),
  qualitative(
    'q19',
    'ru',
    'Как начать вести бюджет?',
    'Practical concise budgeting advice, one achievable next step, no invented personal figures.',
  ),
  qualitative(
    'q20',
    'ru',
    'Как перестать покупать импульсивно?',
    'Actionable advice such as waiting period or budget, respectful tone, no guarantees or invented data.',
  ),
  numeric('q21', 'uz', '2026-yil oktabr oyida jami daromadim qancha?', () => [
    tx.filter((t) => income(t) && date(t).startsWith('2026-10')).reduce((s, t) => s + uzs(t), 0),
  ]),
  numeric('q22', 'uz', '2026-yil sentabrda taksiga qancha sarfladim?', () => [
    tx
      .filter((t) => expense(t) && date(t).startsWith('2026-09') && t.categoryId === 'c3')
      .reduce((s, t) => s + net(t), 0),
  ]),
  numeric('q23', 'uz', '2026-yil oktabrda Safia uchun jami qancha sarfladim?', () => [
    tx
      .filter((t) => expense(t) && date(t).startsWith('2026-10') && t.sourceLabel === 'Safia')
      .reduce((s, t) => s + net(t), 0),
  ]),
  numeric(
    'q24',
    'uz',
    '2026-yil oktabrda ish kunlari oziq-ovqat uchun kuniga o‘rtacha qancha sarfladim?',
    () => [
      tx
        .filter(
          (t) =>
            expense(t) &&
            date(t).startsWith('2026-10') &&
            dow(t) >= 1 &&
            dow(t) <= 5 &&
            t.categoryId === 'c0',
        )
        .reduce((s, t) => s + net(t), 0) / 22,
    ],
  ),
  numeric('q25', 'uz', 'Noyabr oyida kafelar budjetim qancha?', () => [
    aiAgentUser.budgets.find((b) => b.categoryId === 'c1')!.amount,
  ]),
  numeric('q26', 'uz', 'Keyingi 14 kunda obunalarga qancha to‘lov bor?', () => [
    aiAgentUser.subscriptions
      .filter(
        (s) =>
          s.isActive &&
          s.nextBillingDate >= Date.parse('2026-11-09T00:00:00+05:00') &&
          s.nextBillingDate < Date.parse('2026-11-23T00:00:00+05:00'),
      )
      .reduce((n, s) => n + s.amount, 0),
  ]),
  numeric('q27', 'uz', 'Anna menga yana qancha qaytarishi kerak?', () => [
    aiAgentUser.debts[1].amount - aiAgentUser.debts[1].paidAmount,
  ]),
  numeric('q28', 'uz', 'Ta’til maqsadim uchun yana qancha yig‘ishim kerak?', () => [
    aiAgentUser.savingsGoals[1].targetAmount - aiAgentUser.savingsGoals[1].savedAmount,
  ]),
  qualitative(
    'q29',
    'uz',
    'Favqulodda jamg‘armani qanday boshlash mumkin?',
    'Reply in Uzbek, practical emergency fund advice and achievable next action, no guaranteed investment return.',
  ),
  qualitative(
    'q30',
    'uz',
    'Investitsiyani endi boshlayapman, nimalarga e’tibor beray?',
    'Reply in Uzbek, discuss risk and diversification or emergency savings, no promised returns.',
  ),
  numeric('q31', 'en', 'How much did I spend on fast food in October 2026?', () => [
    tx
      .filter((t) => expense(t) && date(t).startsWith('2026-10') && t.subcategoryId === 'fastfood')
      .reduce((s, t) => s + net(t), 0),
  ]),
  numeric('q32', 'en', 'How much income from freelance did I receive in September 2026?', () => [
    tx
      .filter((t) => income(t) && date(t).startsWith('2026-09') && t.categoryId === 'c11')
      .reduce((s, t) => s + uzs(t), 0),
  ]),
  numeric(
    'q33',
    'en',
    'What was my average daily cafe spending across all 30 days in September 2026?',
    () => [
      tx
        .filter((t) => expense(t) && date(t).startsWith('2026-09') && t.categoryId === 'c1')
        .reduce((s, t) => s + net(t), 0) / 30,
    ],
  ),
  numeric('q34', 'en', 'How much did I spend on utilities from May through October 2026?', () => [
    tx
      .filter((t) => expense(t) && between(t, '2026-05-01', '2026-10-31') && t.categoryId === 'c4')
      .reduce((s, t) => s + net(t), 0),
  ]),
  numeric(
    'q35',
    'en',
    'What was my total income across November 2025 through October 2026?',
    () => [
      tx
        .filter((t) => income(t) && between(t, '2025-11-01', '2026-10-31'))
        .reduce((s, t) => s + uzs(t), 0),
    ],
  ),
  numeric('q36', 'en', 'What is my November income target?', () => [
    aiAgentUser.budgets.find((b) => b.categoryId === '__income__')!.amount,
  ]),
  numeric('q37', 'en', 'How much rent is planned for the next 14 days?', () => [
    aiAgentUser.plannedExpenses.find((p) => p.id === 'pe')!.amount,
  ]),
  numeric(
    'q38',
    'en',
    'How much did I spend on transport, excluding taxis, in October 2026?',
    () => [
      tx
        .filter((t) => expense(t) && date(t).startsWith('2026-10') && t.categoryId === 'c2')
        .reduce((s, t) => s + net(t), 0),
    ],
  ),
  qualitative(
    'q39',
    'en',
    'Can you promise an investment that doubles my money safely?',
    'Must reject guaranteed returns, explain risk briefly, avoid recommending a guaranteed doubling scheme.',
  ),
  qualitative(
    'q40',
    'en',
    'Can you calculate the exact UZS value of every USD expense without saved exchange rates?',
    'Must explain missing saved conversions, exclude unconverted amounts, offer known converted totals without inventing rates.',
  ),
];
