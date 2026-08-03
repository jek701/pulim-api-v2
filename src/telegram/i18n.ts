import type { SupportedLanguage } from './types';

const strings = {
  ru: {
    welcome: 'Записывайте расходы и доходы обычным сообщением.\n\nНапример:\n<code>завтрак 45к</code>\n<code>вчера такси 20к, обед 35к</code>\n<code>кофе 3$</code>',
    premium_required: 'Запись транзакций сообщением доступна в Premium. В приложении записывать можно бесплатно.',
    not_linked: 'Не вижу вашего аккаунта Pulim. Откройте приложение один раз — оно свяжет этот чат с вашим профилем.',
    disabled: 'Быстрая запись через Telegram выключена в настройках приложения.',
    cancelled: 'Отменил.',
    unsupported: 'Пока понимаю только текст. Напишите, например: <code>обед 45к</code>',
    too_long: 'Сообщение слишком длинное. Разбейте его на части.',
    error: '⚠️ Что-то пошло не так. Попробуйте ещё раз.',
    unavailable: 'Недоступно.',
    fx_waiting: '⏳ Не удалось получить курс ЦБ. Я сохраню операцию автоматически, как только курс снова станет доступен.',
    parse_failed: 'Не понял 🤔 Напишите так: <code>завтрак 45к</code> или <code>вчера такси 20к, обед 35к</code>',
    rate_minute: 'Слишком часто. Подождите минуту.',
    rate_day: 'На сегодня лимит записей исчерпан (100). Продолжайте в приложении.',
    invalid_amount: 'Не понял сумму, попробуйте ещё раз.',
    invalid_date: 'Не понял дату, попробуйте ещё раз.',
    updated: '✅ Обновлено',
    draft_updated: '❓ Черновик обновлён',
    edit: '✏️ Изменить',
    operation: 'Операция',
  },
  uz: {
    welcome: 'Xarajat va daromadlarni oddiy xabar bilan yozing.\n\nMasalan:\n<code>nonushta 45 ming</code>\n<code>kecha taksi 20 ming, tushlik 35 ming</code>\n<code>coffee 3$</code>',
    premium_required: 'Xabar orqali operatsiya yozish Premium’da mavjud. Ilovada bepul yozish mumkin.',
    not_linked: 'Pulim hisobingizni ko‘rmayapman. Ilovani bir marta oching — chat profilingizga ulanadi.',
    disabled: 'Telegram orqali tezkor yozish sozlamalarda o‘chirilgan.',
    cancelled: 'Bekor qildim.',
    unsupported: 'Hozircha faqat matnni tushunaman. Masalan: <code>tushlik 45 ming</code>',
    too_long: 'Xabar juda uzun. Uni qismlarga bo‘ling.',
    error: '⚠️ Xatolik yuz berdi. Qayta urinib ko‘ring.',
    unavailable: 'Mavjud emas.',
    fx_waiting: '⏳ Markaziy bank kursini olib bo‘lmadi. Kurs qayta ishlashi bilan operatsiyani avtomatik saqlayman.',
    parse_failed: 'Tushunmadim 🤔 Masalan: <code>nonushta 45 ming</code> yoki <code>kecha taksi 20 ming, tushlik 35 ming</code>',
    rate_minute: 'Juda tez-tez. Bir daqiqa kuting.',
    rate_day: 'Bugungi limit tugadi (100). Ilovada davom etishingiz mumkin.',
    invalid_amount: 'Summani tushunmadim, qayta urinib ko‘ring.',
    invalid_date: 'Sanani tushunmadim, qayta urinib ko‘ring.',
    updated: '✅ Yangilandi',
    draft_updated: '❓ Qoralama yangilandi',
    edit: '✏️ Tahrirlash',
    operation: 'Operatsiya',
  },
  en: {
    welcome: 'Record expenses and income with a normal message.\n\nExamples:\n<code>breakfast 45k</code>\n<code>yesterday taxi 20k, lunch 35k</code>\n<code>coffee $3</code>',
    premium_required: 'Recording transactions by message is available with Premium. You can still record them free in the app.',
    not_linked: 'I cannot find your Pulim account. Open the app once to link this chat to your profile.',
    disabled: 'Telegram quick entry is disabled in the app settings.',
    cancelled: 'Cancelled.',
    unsupported: 'For now I only understand text. For example: <code>lunch 45k</code>',
    too_long: 'The message is too long. Split it into parts.',
    error: '⚠️ Something went wrong. Please try again.',
    unavailable: 'Unavailable.',
    fx_waiting: '⏳ The central-bank rate is temporarily unavailable. I will save the transaction automatically when it is available again.',
    parse_failed: 'I could not understand that 🤔 Try: <code>breakfast 45k</code> or <code>yesterday taxi 20k, lunch 35k</code>',
    rate_minute: 'Too many messages. Wait a minute.',
    rate_day: 'Today’s quick-entry limit is exhausted (100). Continue in the app.',
    invalid_amount: 'I could not understand the amount. Please try again.',
    invalid_date: 'I could not understand the date. Please try again.',
    updated: '✅ Updated',
    draft_updated: '❓ Draft updated',
    edit: '✏️ Edit',
    operation: 'Transaction',
  },
} as const;

export type MessageKey = keyof typeof strings.ru;
export const t = (language: SupportedLanguage, key: MessageKey): string => strings[language][key];

export function normalizeLanguage(value: unknown): SupportedLanguage {
  return value === 'uz' || value === 'en' || value === 'ru' ? value : 'ru';
}
