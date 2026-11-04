import type { SupportedLanguage } from '../telegram/types';
import type { ApnsPayload, PushPayload, PushType } from './types';

type Template = readonly [title: string, body: string];
export const pushTemplates: Record<SupportedLanguage, Record<PushType, Template>> = {
  ru: {
    budget_80: ['Бюджет «{category}» почти исчерпан', 'Потрачено {percent}% — осталось {amount} до конца месяца'],
    budget_100: ['Бюджет «{category}» превышен', 'Сверх плана на {amount}. Посмотрим, где можно сэкономить?'],
    subscription_due: ['Сегодня списание: {name}', '{amount} с {account}. Отметить как оплачено?'],
    debt_3d: ['Через 3 дня возврат долга', '{person} · {amount}. Срок — {date}'],
    debt_due: ['Сегодня срок по долгу', '{person} · {amount}'],
    debt_overdue: ['Долг просрочен на {days} дн.', '{person} · {amount}. Напомнить себе позже?'],
    credit_card_due: ['Платёж по карте {name} через 2 дня', 'Минимальный платёж — {amount} до {date}'],
    deposit_ending: ['Депозит {name} заканчивается {date}', 'Решите заранее: продлить или забрать {amount}'],
    deposit_interest: ['Начислены проценты по депозиту', '+{amount} на {name}'],
    goal_reached: ['Цель «{name}» достигнута 🎉', 'Вы накопили {amount}. Отличная работа!'],
    goal_deadline: ['До цели «{name}» 7 дней', 'Осталось накопить {amount}'],
    family_expense: ['{name} добавил расход', '{amount} · {category}'],
    family_joined: ['{name} в семейном бюджете', 'Теперь вы ведёте финансы вместе'],
    premium_activated: ['Premium активен', 'Спасибо! Все функции открыты до {date}'],
    trial_ending: ['Пробный Premium заканчивается {when}', 'Оформите подписку, чтобы сохранить бюджеты, планы и AI'],
    premium_expired: ['Premium закончился', 'Ваши данные на месте. Продлить можно в пару касаний'],
    apple_billing_failed: ['Не удалось продлить Premium', 'Проверьте способ оплаты в настройках Apple — доступ сохранится ещё {days} дн.'],
    evening_log: ['Записали сегодняшние траты?', 'Это займёт 10 секунд — скажите голосом или отсканируйте чек'],
    weekly_summary: ['Итоги недели', 'Расходы {expense}, больше всего — {category}. {change}'],
    monthly_summary: ['Итоги {month}', 'Доходы {income}, расходы {expense}. Смотреть подробнее'],
    broadcast: ['{title}', '{body}'],
  },
  uz: {
    budget_80: ['«{category}» budjeti tugayapti', '{percent}% sarflandi — oy oxirigacha {amount} qoldi'],
    budget_100: ['«{category}» budjetidan oshdingiz', 'Rejadan {amount} ko‘p. Qayerda tejash mumkinligini ko‘ramizmi?'],
    subscription_due: ['Bugungi to‘lov: {name}', '{account} hisobidan {amount}. To‘langan deb belgilaysizmi?'],
    debt_3d: ['Qarzni qaytarishga 3 kun qoldi', '{person} · {amount}. Muddat — {date}'],
    debt_due: ['Bugun qarzni qaytarish kuni', '{person} · {amount}'],
    debt_overdue: ['Qarz muddati {days} kun o‘tdi', '{person} · {amount}. Keyinroq eslataymi?'],
    credit_card_due: ['{name} kartasi to‘loviga 2 kun', 'Eng kam to‘lov — {amount}, muddat {date}'],
    deposit_ending: ['{name} omonati {date} tugaydi', 'Oldindan o‘ylang: uzaytirasizmi yoki {amount} ni olasizmi?'],
    deposit_interest: ['Omonat foizi hisoblandi', '{name} uchun +{amount}'],
    goal_reached: ['«{name}» maqsadiga yetdingiz 🎉', '{amount} yig‘dingiz. Ajoyib natija!'],
    goal_deadline: ['«{name}» maqsadiga 7 kun qoldi', 'Yana {amount} yig‘ish kerak'],
    family_expense: ['{name}: yangi xarajat', '{amount} · {category}'],
    family_joined: ['{name} oilaviy budjetga qo‘shildi', 'Endi moliyani birga yuritasiz'],
    premium_activated: ['Premium yoqildi', 'Rahmat! Barcha imkoniyatlar {date} gacha ochiq'],
    trial_ending: ['Sinov Premium {when} tugaydi', 'Budjetlar, rejalar va AI saqlanishi uchun obuna bo‘ling'],
    premium_expired: ['Premium muddati tugadi', 'Ma’lumotlaringiz saqlangan. Bir necha bosishda uzaytiring'],
    apple_billing_failed: ['Premium uzaytirilmadi', 'Apple sozlamalarida to‘lov usulini tekshiring — kirish yana {days} kun saqlanadi'],
    evening_log: ['Bugungi xarajatlarni yozdingizmi?', '10 soniya yetadi — ovoz bilan ayting yoki chekni skanerlang'],
    weekly_summary: ['Hafta yakuni', 'Xarajatlar {expense}, eng ko‘pi — {category}. {change}'],
    monthly_summary: ['{month} yakuni', 'Daromad {income}, xarajat {expense}. Batafsil ko‘rish'],
    broadcast: ['{title}', '{body}'],
  },
  en: {
    budget_80: ['Your “{category}” budget is almost used', '{percent}% spent — {amount} left for the rest of the month'],
    budget_100: ['Your “{category}” budget is exceeded', '{amount} over budget. Shall we find ways to save?'],
    subscription_due: ['Payment today: {name}', '{amount} from {account}. Mark as paid?'],
    debt_3d: ['Debt repayment in 3 days', '{person} · {amount}. Due {date}'],
    debt_due: ['Debt repayment due today', '{person} · {amount}'],
    debt_overdue: ['Debt is {days} days overdue', '{person} · {amount}. Remind yourself later?'],
    credit_card_due: ['{name} card payment in 2 days', 'Minimum payment: {amount} by {date}'],
    deposit_ending: ['{name} deposit ends on {date}', 'Plan ahead: renew or withdraw {amount}'],
    deposit_interest: ['Deposit interest accrued', '+{amount} on {name}'],
    goal_reached: ['Goal “{name}” reached 🎉', 'You saved {amount}. Great work!'],
    goal_deadline: ['7 days until your “{name}” goal', '{amount} left to save'],
    family_expense: ['{name}: new expense', '{amount} · {category}'],
    family_joined: ['{name} joined the family budget', 'You can now manage your finances together'],
    premium_activated: ['Premium is active', 'Thank you! All features are unlocked until {date}'],
    trial_ending: ['Your Premium trial ends {when}', 'Subscribe to keep budgets, plans and AI'],
    premium_expired: ['Premium has ended', 'Your data is safe. Renew in just a few taps'],
    apple_billing_failed: ['Could not renew Premium', 'Check your payment method in Apple settings — access continues for {days} more days'],
    evening_log: ['Logged today’s expenses?', 'It takes 10 seconds — use your voice or scan a receipt'],
    weekly_summary: ['Your weekly summary', 'Expenses {expense}, mostly on {category}. {change}'],
    monthly_summary: ['Your {month} summary', 'Income {income}, expenses {expense}. View details'],
    broadcast: ['{title}', '{body}'],
  },
};

export function truncatePushText(text: string, limit: number): string {
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment);
  // APNs clients also count code points, so keep both limits even for compound emoji.
  let result = '';
  let size = 0;
  for (const part of graphemes) {
    const length = Array.from(part).length;
    if (size + length > limit) break;
    result += part;
    size += length;
  }
  if (result === text) return text;
  while (Array.from(result).length >= limit) {
    const segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(result), part => part.segment);
    segments.pop();
    result = segments.join('');
  }
  return `${result.trimEnd()}…`;
}

export function renderPush(payload: PushPayload, language: SupportedLanguage, notificationId: string): ApnsPayload {
  const values = { ...payload.values };
  if (payload.type === 'trial_ending') {
    values.when = Number(values.days) === 1
      ? { ru: 'завтра', uz: 'ertaga', en: 'tomorrow' }[language]
      : { ru: 'через 3 дня', uz: '3 kundan keyin', en: 'in 3 days' }[language];
  }
  const replace = (text: string) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
  const [title, body] = pushTemplates[language][payload.type];
  const category: ApnsPayload['aps']['category'] = payload.type === 'subscription_due' ? 'SUBSCRIPTION_DUE'
    : ['debt_3d', 'debt_due', 'debt_overdue'].includes(payload.type) ? 'DEBT_DUE'
      : payload.type === 'evening_log' ? 'EVENING_LOG' : undefined;
  return {
    aps: {
      alert: { title: truncatePushText(replace(title), 50), body: truncatePushText(replace(body), 150) },
      sound: 'default', 'thread-id': payload.group,
      ...(category ? { category } : {}),
      'interruption-level': payload.type === 'budget_100' || payload.type === 'apple_billing_failed' ? 'time-sensitive' : 'active',
    },
    type: payload.type, link: payload.link, notificationId,
    ...(payload.entityId ? { entityId: payload.entityId } : {}),
  };
}
