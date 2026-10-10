import { env } from '../../config/env';
import { categoryDisplayName } from '../../telegram/categoryAliases';
import type { SupportedLanguage } from '../../telegram/types';
import { formatDate, formatDateRange, formatMoney, formatMonth, formatNumber, pluralDays, safe } from '../format';
import { localized, notificationStrings } from '../i18n';
import type {
  BudgetPayload,
  CategoryTotal,
  DailyEvent,
  DailyPayload,
  LifecyclePayload,
  MonthlyPayload,
  NotificationPayload,
  RenderedNotification,
  WeeklyPayload,
} from '../types';
import { renderKeyboard } from './keyboard';

function categoryName(category: CategoryTotal, language: SupportedLanguage): string {
  return categoryDisplayName({ name: category.name, icon: category.icon, type: category.categoryType }, language);
}

function renderLifecycle(payload: LifecyclePayload, language: SupportedLanguage): string {
  const until = payload.premiumUntil
    ? formatDate(payload.premiumUntil, language, env.NOTIFY_TIMEZONE)
    : '';
  switch (payload.kind) {
    case 'trial_ending_1d':
      return localized(language,
        `💎 <b>Пробный период заканчивается завтра</b>\nПосле ${until} Premium-функции станут недоступны. Все данные останутся на месте.`,
        `💎 <b>Sinov muddati ertaga tugaydi</b>\n${until} dan keyin Premium imkoniyatlari yopiladi. Barcha ma’lumotlar saqlanadi.`,
        `💎 <b>Your trial ends tomorrow</b>\nPremium features become unavailable after ${until}. Your data stays safe.`);
    case 'trial_ending_3d':
      return localized(language,
        `💎 <b>Пробный период заканчивается через 3 дня</b>\nПосле ${until} Premium-функции станут недоступны. Все данные останутся на месте.`,
        `💎 <b>Sinov muddati 3 kundan keyin tugaydi</b>\n${until} dan keyin Premium imkoniyatlari yopiladi. Barcha ma’lumotlar saqlanadi.`,
        `💎 <b>Your trial ends in 3 days</b>\nPremium features become unavailable after ${until}. Your data stays safe.`);
    case 'premium_expired':
      return localized(language,
        '💎 <b>Premium закончился</b>\nPremium-функции отключены, но все ваши данные сохранены.',
        '💎 <b>Premium muddati tugadi</b>\nPremium imkoniyatlari o‘chirildi, barcha ma’lumotlaringiz saqlandi.',
        '💎 <b>Premium has ended</b>\nPremium features are off, but all your data is safe.');
    case 'trial_available':
      return localized(language,
        '🎁 <b>Попробуйте Premium бесплатно 7 дней</b>\nОткройте бюджеты, долги, депозиты, накопления и расширенную аналитику.',
        '🎁 <b>Premium’ni 7 kun bepul sinab ko‘ring</b>\nBudjetlar, qarzlar, depozitlar, jamg‘armalar va kengaytirilgan tahlilni oching.',
        '🎁 <b>Try Premium free for 7 days</b>\nUnlock budgets, debts, deposits, savings, and advanced analytics.');
    case 'no_cards':
      return localized(language,
        '📱 <b>Настройте первый счёт</b>\nДобавьте карту или наличные за минуту, чтобы Pulim правильно считал баланс.',
        '📱 <b>Birinchi hisobni sozlang</b>\nPulim balansni to‘g‘ri hisoblashi uchun bir daqiqada karta yoki naqd hisob qo‘shing.',
        '📱 <b>Set up your first account</b>\nAdd a card or cash account in a minute so Pulim can track your balance.');
  }
}

function eventLine(event: DailyEvent, language: SupportedLanguage, completed = false): string {
  const prefix = completed ? '✅' : '·';
  if (event.kind === 'subscription') {
    const due = event.due === 'today'
      ? localized(language, 'сегодня', 'bugun', 'today')
      : localized(language, 'завтра', 'ertaga', 'tomorrow');
    return `${prefix} ${safe(event.icon)} ${safe(event.name)} — ${formatMoney(event.amount, event.currency, language)}, ${due}`;
  }
  if (event.kind === 'debt') {
    const verb = event.direction === 'i_owe'
      ? localized(language, 'вернуть', 'qaytarish', 'repay')
      : localized(language, 'вам должны', 'sizga qaytarishadi', 'owed to you');
    const due = event.due === 'today'
      ? localized(language, 'сегодня', 'bugun', 'today')
      : event.due === 'in_3_days'
        ? localized(language, 'через 3 дня', '3 kundan keyin', 'in 3 days')
        : localized(language, 'просрочен', 'muddati o‘tgan', 'overdue');
    return `${prefix} ${verb} ${safe(event.person)} ${formatMoney(event.remaining, event.currency, language)} — ${due}`;
  }
  if (event.kind === 'credit_card') {
    const due = event.due === 'today'
      ? localized(language, 'сегодня', 'bugun', 'today')
      : localized(language, 'через 2 дня', '2 kundan keyin', 'in 2 days');
    return `· 💳 ${safe(event.name)} — ${formatMoney(event.balance, event.currency, language)}, ${due}`;
  }
  if (event.kind === 'deposit') {
    const label = event.event === 'interest'
      ? localized(language, 'накопленные проценты', 'yig‘ilgan foiz', 'accrued interest')
      : event.event === 'ends_1d'
        ? localized(language, 'закрывается завтра', 'ertaga yopiladi', 'ends tomorrow')
        : localized(language, 'закрывается через 7 дней', '7 kundan keyin yopiladi', 'ends in 7 days');
    return `· 🏛 ${safe(event.bank)} — ${label}${event.event === 'interest' ? `: ${formatMoney(event.amount, event.currency, language)}` : ''}`;
  }
  return `· ${safe(event.name)} — ${localized(language, 'до цели осталось', 'maqsadgacha qoldi', 'remaining')} ${formatMoney(event.remaining, event.currency, language)}`;
}

function renderWeekly(payload: WeeklyPayload, language: SupportedLanguage): string {
  const title = `${notificationStrings.weekly(language)} ${formatDateRange(payload.from, payload.to, language, env.NOTIFY_TIMEZONE)}`;
  if (payload.empty) {
    return `${title}\n\n${localized(language,
      'За неделю ни одной записи. Записать трату можно прямо здесь: <code>обед 45к</code>',
      'Hafta davomida yozuv bo‘lmadi. Xarajatni shu yerda yozing: <code>tushlik 45 ming</code>',
      'No entries last week. Record an expense right here: <code>lunch 45k</code>')}`;
  }
  const change = payload.expenseChangePercent === null ? ''
    : ` (${payload.expenseChangePercent > 0 ? '+' : '−'}${Math.abs(payload.expenseChangePercent)}% ${localized(language, 'к прошлой неделе', 'o‘tgan haftaga nisbatan', 'vs previous week')})`;
  const lines = [
    title,
    '',
    `${localized(language, 'Расходы', 'Xarajatlar', 'Expenses')}: ${formatMoney(payload.expense, 'UZS', language)}${change}`,
    `${localized(language, 'Доходы', 'Daromadlar', 'Income')}: ${formatMoney(payload.income, 'UZS', language)}`,
    `${localized(language, 'Записано операций', 'Operatsiyalar soni', 'Transactions recorded')}: ${payload.operationCount}`,
  ];
  if (payload.unconvertedCount) lines.push(localized(language,
    `${payload.unconvertedCount} операций без курса`, `${payload.unconvertedCount} operatsiyada kurs yo‘q`, `${payload.unconvertedCount} transactions without an exchange rate`));
  if (payload.topCategories.length) {
    lines.push('', `${localized(language, 'Топ категорий', 'Top toifalar', 'Top categories')}:`);
    payload.topCategories.forEach((category, index) => lines.push(
      `${index + 1}. ${safe(category.icon)} ${safe(categoryName(category, language))} — ${formatNumber(category.amount)}`,
    ));
  }
  if (payload.aiInsight) lines.push('', `💡 ${safe(payload.aiInsight, 500)}`);
  return lines.join('\n');
}

function renderMonthly(payload: MonthlyPayload, language: SupportedLanguage): string {
  const month = formatMonth(payload.monthStart, language, env.NOTIFY_TIMEZONE);
  const lines = [
    `${notificationStrings.monthly(language)} ${month}`,
    '',
    `${localized(language, 'Доходы', 'Daromadlar', 'Income')}: ${formatMoney(payload.income, 'UZS', language)}`,
    `${localized(language, 'Расходы', 'Xarajatlar', 'Expenses')}: ${formatMoney(payload.expense, 'UZS', language)}`,
    `${localized(language, 'Остаток', 'Qoldiq', 'Net')}: ${payload.income - payload.expense >= 0 ? '+' : '−'}${formatMoney(Math.abs(payload.income - payload.expense), 'UZS', language)}`,
  ];
  if (payload.unconvertedCount) lines.push(localized(language,
    `${payload.unconvertedCount} операций без курса`, `${payload.unconvertedCount} operatsiyada kurs yo‘q`, `${payload.unconvertedCount} transactions without an exchange rate`));
  if (payload.topCategories.length) {
    lines.push('', `${localized(language, 'Топ категорий', 'Top toifalar', 'Top categories')}:`);
    payload.topCategories.forEach((category, index) => lines.push(
      `${index + 1}. ${safe(category.icon)} ${safe(categoryName(category, language))} — ${formatNumber(category.amount)} (${category.percent ?? 0}%)`,
    ));
  }
  if (payload.budgetsTotal) lines.push('', `${localized(language, 'Бюджеты', 'Budjetlar', 'Budgets')}: ${payload.budgetsOk} ${localized(language, `из ${payload.budgetsTotal} в норме`, `${payload.budgetsTotal} tadan me’yorda`, `of ${payload.budgetsTotal} on track`)}`);
  payload.exceededBudgets.slice(0, 2).forEach((budget) => lines.push(
    `⚠️ ${safe(budget.icon)} ${safe(categoryName(budget, language))} — ${localized(language, 'превышен на', 'oshdi', 'over by')} ${formatMoney(budget.overBy, 'UZS', language)}`,
  ));
  if (payload.subscriptionsTotal > 0) lines.push('', `${localized(language, 'Подписки за месяц', 'Oylik obunalar', 'Subscriptions this month')}: ${formatMoney(payload.subscriptionsTotal, 'UZS', language)}`);
  if (payload.aiInsight) lines.push('', `💡 <b>${localized(language, 'Разбор', 'Tahlil', 'Insight')}</b>\n${safe(payload.aiInsight.insight, 500)} ${safe(payload.aiInsight.tip, 500)}`);
  else if (payload.premiumUpsell) lines.push('', localized(language,
    '💡 Персональный разбор месяца доступен в Premium',
    '💡 Oylik shaxsiy tahlil Premium’da mavjud',
    '💡 A personal monthly insight is available with Premium'));
  return lines.join('\n');
}

function renderDaily(payload: DailyPayload, language: SupportedLanguage, completedActions: number[]): string {
  const sections = [`${notificationStrings.greeting(language)} ${formatDate(payload.date, language, env.NOTIFY_TIMEZONE)}`];
  if (payload.lifecycle) sections.push(renderLifecycle(payload.lifecycle, language));
  if (payload.events.length) {
    const visible = payload.events.slice(0, 8);
    let actionIndex = 0;
    const lines = [`<b>${notificationStrings.events(language)}</b>`, ...visible.map((event) => {
      const actionable = event.kind === 'subscription' || event.kind === 'debt';
      const completed = actionable && completedActions.includes(actionIndex);
      if (actionable) actionIndex += 1;
      return eventLine(event, language, completed);
    })];
    if (payload.events.length > visible.length) lines.push(localized(language,
      `… и ещё ${payload.events.length - visible.length}`, `… yana ${payload.events.length - visible.length} ta`, `… and ${payload.events.length - visible.length} more`));
    sections.push(lines.join('\n'));
  }
  if (payload.report) sections.push(payload.report.kind === 'weekly'
    ? renderWeekly(payload.report, language)
    : renderMonthly(payload.report, language));
  if (payload.premiumDataUpsell) sections.push(localized(language,
    '💎 Управлять долгами и накоплениями можно в Premium',
    '💎 Qarzlar va jamg‘armalarni Premium’da boshqarish mumkin',
    '💎 Manage debts and savings with Premium'));
  return sections.join('\n\n');
}

function renderBudget(payload: BudgetPayload, language: SupportedLanguage): string {
  const title = payload.threshold === 100
    ? localized(language, '🔴 <b>Бюджет превышен</b>', '🔴 <b>Budjet oshib ketdi</b>', '🔴 <b>Budget exceeded</b>')
    : localized(language, '⚠️ <b>Бюджет на исходе</b>', '⚠️ <b>Budjet tugamoqda</b>', '⚠️ <b>Budget nearly used</b>');
  const name = categoryDisplayName({ name: payload.categoryName, icon: payload.categoryIcon, type: payload.categoryType }, language);
  const detail = payload.threshold === 100
    ? `(+${formatMoney(payload.spent - payload.budget, 'UZS', language)})`
    : `(${Math.floor((payload.spent / payload.budget) * 100)}%)`;
  const lines = [title, '', `${safe(payload.categoryIcon)} ${safe(name)}: ${formatNumber(payload.spent)} ${localized(language, 'из', 'dan', 'of')} ${formatMoney(payload.budget, 'UZS', language)} ${detail}`];
  if (payload.threshold === 80) {
    const remaining = Math.max(0, payload.budget - payload.spent);
    const perDay = payload.daysLeft > 0 ? remaining / payload.daysLeft : remaining;
    lines.push(localized(language,
      `Осталось ${formatMoney(remaining, 'UZS', language)} на ${pluralDays(payload.daysLeft, language)} — это ${formatMoney(perDay, 'UZS', language)} в день.`,
      `${pluralDays(payload.daysLeft, language)} uchun ${formatMoney(remaining, 'UZS', language)} qoldi — kuniga ${formatMoney(perDay, 'UZS', language)}.`,
      `${formatMoney(remaining, 'UZS', language)} remains for ${pluralDays(payload.daysLeft, language)} — ${formatMoney(perDay, 'UZS', language)} per day.`));
  }
  if (payload.topDetail) lines.push('', `💡 ${localized(language, 'Больше всего ушло на', 'Eng ko‘p sarflangan', 'Most went to')} ${safe(payload.topDetail.label)} — ${formatMoney(payload.topDetail.amount, 'UZS', language)}.`);
  return lines.join('\n');
}

function renderTrialStarted(payload: Extract<NotificationPayload, { kind: 'trial_started' }>, language: SupportedLanguage): string {
  const until = formatDate(payload.premiumUntil, language, env.NOTIFY_TIMEZONE);
  return localized(language,
    `🎉 <b>Premium включён на 7 дней — до ${until}</b>\n\nЧто стало доступно:\n📊 бюджеты по категориям\n🤝 долги и погашения\n🏛 депозиты и 🎯 накопления\n💳 кредитные и наличные счета\n📈 расширенные графики и фильтры\n\nНачните с бюджета на еду — это занимает минуту.`,
    `🎉 <b>Premium 7 kunga yoqildi — ${until} gacha</b>\n\nEndi mavjud:\n📊 toifalar bo‘yicha budjetlar\n🤝 qarzlar va to‘lovlar\n🏛 depozitlar va 🎯 jamg‘armalar\n💳 kredit va naqd hisoblar\n📈 kengaytirilgan grafik va filtrlar\n\nOziq-ovqat budjetidan boshlang — bir daqiqa vaqt oladi.`,
    `🎉 <b>Premium is on for 7 days — until ${until}</b>\n\nNow available:\n📊 category budgets\n🤝 debts and repayments\n🏛 deposits and 🎯 savings\n💳 credit and cash accounts\n📈 advanced charts and filters\n\nStart with a food budget — it takes one minute.`);
}

export function renderNotification(
  payload: NotificationPayload,
  language: SupportedLanguage,
  includeIntro = false,
  completedActions: number[] = [],
): RenderedNotification {
  let text = payload.kind === 'daily' ? renderDaily(payload, language, completedActions)
    : payload.kind === 'budget' ? renderBudget(payload, language)
      : payload.kind === 'campaign' ? `<b>${safe(payload.title, 80)}</b>\n\n${safe(payload.body, 2_000)}`
        : renderTrialStarted(payload, language);
  if (includeIntro) text += localized(language,
    '\n\n—\nЭто напоминания Pulim. Отключить: /stop',
    '\n\n—\nBu Pulim eslatmalari. O‘chirish: /stop',
    '\n\n—\nThese are Pulim reminders. Disable: /stop');
  const renderedKeyboard = renderKeyboard(payload, language, completedActions);
  return { text, ...renderedKeyboard, language };
}
