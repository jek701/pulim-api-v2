# ТЗ: проактивные уведомления, напоминания и отчёты в Telegram

**Версия:** 1.0 · **Дата:** 2026-08-02 · **Исполнитель:** AI Codex
**Репозитории:** `pulim-api-v2` (основной объём), `pulim-ui-v2` (настройки и баннер)

> **Зависимость.** Это ТЗ опирается на [TZ-telegram-quick-entry.md](TZ-telegram-quick-entry.md):
> оттуда берутся клиент Bot API (`src/telegram/client.ts`), диспетчер апдейтов,
> обработчик callback-кнопок, коллекция `telegramMessages`, словарь `src/telegram/i18n.ts`,
> поле `profile.language` и резолвер `telegramId → uid`. Делать это ТЗ **после** первого.
> Если первое ещё не сделано — сначала реализовать из него разделы 2.1 (клиент, диспетчер,
> i18n) и 9.2 (синхронизация языка), остальное не требуется.

---

## 0. Задача

Сейчас Pulim не отправляет пользователю ничего и живёт только пока о нём помнят. Нужно
регулярно и по делу напоминать о себе в Telegram: события дня, отчёты за неделю и месяц,
предупреждения о бюджетах и события подписки — так, чтобы это было полезно, а не спам.

**Главный риск фичи — блокировка бота.** Заблокированный бот перестаёт доставлять всё, включая
быструю запись транзакций текстом. Поэтому частота, тихие часы, суточная капа и «не отправлять,
если нечего сказать» — это не украшения, а обязательные требования.

---

## 1. Что уже есть и чего нет

### 1.1. Инфраструктура

| Компонент | Состояние |
|---|---|
| Web Push / FCM | **Нет.** `messagingSenderId` в конфиге есть, но `firebase/messaging`, `firebase-messaging-sw.js` и VAPID отсутствуют. Service worker в `vite.config.ts` — только workbox-кэш |
| Telegram-доставка | Токен в env, `profiles.telegramChatIds[]`, коллекция `telegramUsers`; клиент Bot API появится по первому ТЗ |
| Планировщик / cron | **Нет.** `src/server.ts` — только `app.listen()`, ни Docker, ни воркера |
| Образец воркера с очередью и бэкоффом | `pulim-payment-api/src/worker.ts` + `src/services/outbox.service.ts` + сервис `worker` в `compose.yaml` — копировать оттуда |
| Тестовый фреймворк в `pulim-api-v2` | Добавляется первым ТЗ (`vitest`) |

### 1.2. Источники поводов (всё уже в базе)

| Данные | Повод | Готовая логика |
|---|---|---|
| `subscriptions.nextBillingDate`, `cycle`, `isActive` | Списание сегодня/завтра | `paySubscription` в `services/subscription.service.ts` |
| `debts.dueDate`, `isPaid`, `paidAmount` | Вернуть долг / вам должны | `payDebt` в `services/debt.service.ts` |
| `planned_expenses` | Запланировано на сегодня | `domain/recurrence.ts:plannedAppliesToDay` |
| `deposits.endDate`, `interestPaidOut`, `showInterest` | Закрытие, накопленные проценты | `domain/deposit.ts:calcRemainingInterest` |
| `cards.dueDay`, `cardType: 'credit'` | Платёж по кредитке | — |
| `budgets` + транзакции месяца | 80% / превышение | расчёт продублирован из `pulim-ui-v2/src/pages/Home.tsx:143` |
| `profile.salarySources[].day` | «Сегодня зарплата — записать?» | **поле собирается в онбординге и нигде не используется** |
| `profile.familyMembers[].birthday` | «Через 3 дня ДР — заложить на подарок» | **поле собирается и нигде не используется** |
| `savingsGoals.deadline`, `savedAmount` | Дедлайн цели близко | — |
| `subscription.premiumUntil`, `isTrial` | Конец триала, истёкший Premium | платёжный флоу готов |
| `prompts/buildContext.ts` | AI-разбор месяца | `buildForecastPrompt` — образец компактного промпта |

### 1.3. Ограничения Telegram, определяющие дизайн

1. **Бот не может написать первым тому, кто не нажимал Start.** Открытие Mini App разрешения
   не даёт. `sendMessage` вернёт `403 Forbidden: bot can't initiate conversation with a user`.
2. **Пользователь может заблокировать бота:** `403 Forbidden: bot was blocked by the user`.
   Продолжать слать нельзя — Telegram начнёт ограничивать бота целиком.
3. **Лимиты частоты:** ~30 сообщений/сек суммарно, ~1 сообщение/сек в один чат.
   Превышение → `429` с полем `parameters.retry_after`.

### 1.4. Принятые решения (не пересматривать)

| Вопрос | Решение |
|---|---|
| Канал | Только Telegram |
| Планировщик | Отдельный процесс-воркер в `pulim-api-v2` |
| Состав v1 | Утренний дайджест · отчёты неделя/месяц · бюджеты 80% и 100% · жизненный цикл (триал, Premium, онбординг) |
| Согласие | Включено сразу, отключается в настройках |
| Время дайджеста | 09:00 Asia/Tashkent по умолчанию, выбор из трёх слотов |
| Доступ | Всем; AI-разбор в месячном отчёте — только Premium |
| Действия из чата | Разрешены, но строго в два тапа с подтверждением |
| Вечерняя сводка | Есть, но **выключена по умолчанию** и только если за день были операции |

---

## 2. Архитектура

```
┌─ pulim-api-v2 ────────────────────────────────────────────────┐
│                                                               │
│  server.ts (HTTP)                    worker.ts (новый процесс)│
│    /v1/*                               planner  каждые 15 мин │
│    /telegram/webhook                   delivery каждые 5 сек  │
│         │                                    │                │
│         └──────── Firestore ─────────────────┘                │
│                  notifications (очередь + журнал)             │
│                  profiles.notifications (настройки, слоты)    │
└───────────────────────────────────────────────────────────────┘
```

**Почему два цикла.** Планировщик читает много данных на пользователя (транзакции, бюджеты,
подписки) — это медленно. Доставка обязана быть быстрой и соблюдать лимиты Telegram.
Смешивать их в одном цикле нельзя: одна тяжёлая выборка задержит всю рассылку.

**Почему отдельный процесс.** Рассылка не должна конкурировать за event loop с HTTP-запросами
пользователей, а рестарт API не должен ронять наполовину выполненный проход планировщика.

### 2.1. Новые файлы

```
src/worker.ts                                   точка входа воркера
src/notifications/planner.ts                    цикл планирования
src/notifications/delivery.ts                   цикл доставки
src/notifications/queue.repository.ts           коллекция notifications
src/notifications/settings.ts                   чтение/дефолты profile.notifications
src/notifications/schedule.ts                   расчёт слотов в Asia/Tashkent (чистая)
src/notifications/collectors/digest.ts          сбор событий дня (чистая + запросы)
src/notifications/collectors/evening.ts         итог дня
src/notifications/collectors/weekly.ts          недельный отчёт
src/notifications/collectors/monthly.ts         месячный отчёт
src/notifications/collectors/budget.ts          пороги бюджетов
src/notifications/collectors/lifecycle.ts       триал / Premium / онбординг
src/notifications/render/*.ts                   payload → текст + клавиатура
src/notifications/monthlyAi.ts                  AI-комментарий к месяцу (Premium)
src/telegram/handlers/actions.handler.ts        кнопки «Оплатить» / «Погасить» / «Записать»
src/routes/notificationSettings.routes.ts       PATCH /v1/profile/notifications
scripts/backfill-notification-settings.ts       разовая миграция существующих профилей
```

Тесты:

```
tests/notifications/schedule.test.ts
tests/notifications/digest.test.ts
tests/notifications/weekly.test.ts
tests/notifications/budget.test.ts
tests/notifications/backoff.test.ts
```

### 2.2. Изменения в существующих файлах

| Файл | Изменение |
|---|---|
| `package.json` | Скрипты `"worker": "node dist/worker.js"`, `"dev:worker": "tsx watch src/worker.ts"` |
| `src/config/env.ts` | Переменные из 2.3 |
| `src/domain/types.ts` | `UserProfile.notifications?: NotificationSettings` (раздел 3.1) |
| `src/domain/schemas.ts` | `notificationSettingsPatchSchema` |
| `src/routes/index.ts` | Смонтировать `notificationSettings.routes.ts` под `/v1/profile/notifications` |
| `src/services/profile.service.ts` | В `bootstrap()` — `ensureNotificationDefaults(uid)` (см. 3.2) |
| `src/services/transaction.service.ts` | После успешного `createTransaction` / `updateTransaction` — `void scheduleBudgetCheck(uid)` (fire-and-forget, ошибку глотать) |
| `src/telegram/handlers/callback.handler.ts` | Подключить `actions.handler.ts` |
| `src/telegram/handlers/command.handler.ts` | `/settings`, `/stop`, обработка `?start=notify` |
| `README.md`, `.env.example` | Воркер, переменные, индексы, установка вебхука |
| `firestore.indexes.json` (в `pulim-ui-v2`) | Композитный индекс из 2.4 |

### 2.3. Переменные окружения

```dotenv
# ── Notifications ────────────────────────────────────────────────────────────
NOTIFICATIONS_ENABLED=true
NOTIFY_TIMEZONE=Asia/Tashkent

NOTIFY_PLANNER_INTERVAL_MS=900000        # 15 минут
NOTIFY_DELIVERY_INTERVAL_MS=5000         # 5 секунд
NOTIFY_PLANNER_BATCH=200                 # профилей за проход
NOTIFY_DELIVERY_BATCH=50                 # заданий за проход

NOTIFY_QUIET_START_HOUR=22               # с 22:00 не шлём
NOTIFY_QUIET_END_HOUR=8                  # до 08:00 не шлём
NOTIFY_MAX_PER_USER_PER_DAY=3
NOTIFY_STALE_AFTER_MS=21600000           # 6 часов — задание протухло, пропускаем
NOTIFY_MAX_ATTEMPTS=8
NOTIFY_SEND_RATE_PER_SEC=25              # < 30, запас на вебхук-ответы бота

NOTIFY_MONTHLY_AI_ENABLED=true
NOTIFY_MONTHLY_AI_MODEL=gpt-5.4-mini
NOTIFY_MONTHLY_AI_MAX_OUTPUT_TOKENS=1200
```

Валидация: при `NOTIFICATIONS_ENABLED=true` обязательны `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_BOT_USERNAME`, `WEB_APP_URL`. `NOTIFY_QUIET_END_HOUR` должен быть ≤ минимального
слота дайджеста (08:00).

### 2.4. Индексы Firestore

Одно составное правило для очереди доставки:

```json
{
  "collectionGroup": "notifications",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "nextAttemptAt", "order": "ASCENDING" }
  ]
}
```

Запросы планировщика (`profiles.where('notifications.nextDigestAt','<=',now).limit(N)`)
обходятся автоматическими одиночными индексами — вложенные поля map индексируются по умолчанию.

TTL-политики (включаются в консоли, описать в README): поле `expiresAt` в `notifications`.

---

## 3. Модель настроек

### 3.1. `profile.notifications`

```ts
export interface NotificationSettings {
  enabled: boolean;                 // главный тумблер, default true
  digestHour: 8 | 9 | 20;           // default 9, локальное время Asia/Tashkent

  types: {
    digest: boolean;                // события дня            default true
    weekly: boolean;                // отчёт за неделю        default true
    monthly: boolean;               // отчёт за месяц         default true
    budget: boolean;                // пороги бюджетов        default true
    lifecycle: boolean;             // триал / Premium        default true
    evening: boolean;               // итог дня               default FALSE (opt-in)
  };

  telegram: {
    chatId: number | null;          // канонический чат рассылки
    status: 'unknown' | 'reachable' | 'unreachable' | 'blocked';
    lastError: string | null;
    checkedAt: number;
  };

  // Планировочные метки — управляются только сервером
  nextDigestAt: number;
  nextEveningAt: number;
  nextWeeklyAt: number;
  nextMonthlyAt: number;

  introSentAt: number | null;       // когда отправили первое пояснительное сообщение
  sentDay: string;                  // 'YYYY-MM-DD' для суточной капы
  sentCount: number;
  lastSentAt: number | null;
}
```

`chatId` берётся как `profile.telegramChatIds[последний]`, а при обращении пользователя к боту
перезаписывается на актуальный `message.chat.id`.

### 3.2. Дефолты и обратная миграция

**Критично:** Firestore не возвращает документы, у которых запрашиваемого поля нет. Профили,
созданные до этой фичи, не имеют `notifications.nextDigestAt` и в выборку планировщика
не попадут никогда.

Поэтому:

1. `ensureNotificationDefaults(uid)` вызывается из `bootstrap()` (он и так дёргается при каждом
   входе) — идемпотентно проставляет дефолты, если `profile.notifications` отсутствует.
2. `scripts/backfill-notification-settings.ts` — разовый прогон по всем профилям батчами
   по 400, ставит дефолты тем, у кого их нет. Запускается вручную один раз после деплоя,
   описать в README.
3. Пересчёт слотов при смене `digestHour` — на сервере, в обработчике
   `PATCH /v1/profile/notifications`.

### 3.3. Эндпоинт настроек

```
PATCH /v1/profile/notifications
{
  "enabled": true,
  "digestHour": 9,
  "types": { "digest": true, "weekly": true, "monthly": true,
             "budget": true, "lifecycle": true, "evening": false }
}
→ 200 { ...NotificationSettings }
```

Схема `.strip()`: клиент не может писать `telegram.*`, `next*At`, `sentCount`, `introSentAt`.
После патча сервер пересчитывает `nextDigestAt` / `nextEveningAt` и, если `enabled === false`,
переводит все `pending`-задания пользователя в `cancelled`.

---

## 4. Очередь `notifications`

Одна коллекция служит и очередью, и журналом отправленного — это же даёт дедупликацию.

```ts
{
  userId: string;
  chatId: number;
  type: 'digest' | 'evening' | 'weekly' | 'monthly'
      | 'budget_80' | 'budget_100'
      | 'trial_3d' | 'trial_1d' | 'premium_expired' | 'onboarding';
  dedupeKey: string;
  status: 'pending' | 'sent' | 'skipped' | 'failed' | 'cancelled';

  runAt: number;
  nextAttemptAt: number;
  attempts: number;
  lastError: string | null;
  skipReason: string | null;

  payload: Record<string, unknown>;   // структурированные данные, см. раздел 6
  language: 'en' | 'ru' | 'uz';

  messageId: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  expiresAt: number;                  // sentAt + 90 дней / createdAt + 90 дней
}
```

**Идентификатор документа = `sha256(dedupeKey).slice(0, 32)`**, запись строго через `create()`.
Повторный проход планировщика получит `ALREADY_EXISTS` и ничего не продублирует.

Ключи дедупликации:

| Тип | Ключ |
|---|---|
| digest | `digest:{uid}:{YYYY-MM-DD}` |
| evening | `evening:{uid}:{YYYY-MM-DD}` |
| weekly | `weekly:{uid}:{YYYY}-W{ww}` |
| monthly | `monthly:{uid}:{YYYY-MM}` |
| budget_80 / budget_100 | `budget{80\|100}:{uid}:{categoryId}:{YYYY-MM}` |
| trial_3d / trial_1d | `trial{3\|1}d:{uid}:{premiumUntil YYYY-MM-DD}` |
| premium_expired | `premium_expired:{uid}:{YYYY-MM-DD}` |
| onboarding | `onboarding:{uid}` |

---

## 5. Воркер

### 5.1. `src/worker.ts`

Скопировать структуру `pulim-payment-api/src/worker.ts`: два `setInterval`, защита от
наложения прогонов (если предыдущий промис не завершён — пропустить тик), `unref()`,
корректный `SIGINT`/`SIGTERM` с ожиданием текущих прогонов, `logger` из существующего
`utils/logger.ts`.

При `NOTIFICATIONS_ENABLED=false` воркер стартует, пишет warn и не заводит таймеры.

### 5.2. Планировщик (раз в 15 минут)

Для каждого типа — отдельная выборка. Батч ограничен `NOTIFY_PLANNER_BATCH`; если выборка
вернула полный батч, планировщик сразу делает следующий проход по этому типу (до 10 итераций
за тик), чтобы очередь не отставала.

```
1. DIGEST
   profiles.where('notifications.nextDigestAt', '<=', now).limit(BATCH)
   для каждого:
      a) СНАЧАЛА сдвинуть nextDigestAt на завтра в его слот    ← до сбора данных,
         чтобы падение сборщика не крутило одного пользователя вечно
      b) если !enabled || !types.digest || telegram.status in (blocked, unreachable) → continue
      c) собрать payload (collectors/digest.ts)
      d) payload.sections пуст → continue          ← «нечего сказать — не пишем»
      e) create() задания с dedupeKey и runAt = now

2. EVENING   — то же, поле nextEveningAt, слот 21:00, types.evening
3. WEEKLY    — nextWeeklyAt, понедельник в digestHour, types.weekly
4. MONTHLY   — nextMonthlyAt, 1-е число в digestHour, types.monthly
5. LIFECYCLE — profiles.where('subscription.premiumUntil','>=',now)
                       .where('subscription.premiumUntil','<=',now + 3d)
               + отдельно истёкшие за последние 24 ч
               + онбординг: subscription.trialGrantedAt в окне 24–48 ч назад
                 и (onboardingComplete !== true || карт нет)
6. BUDGET    — не по расписанию; задания ставит scheduleBudgetCheck (см. 5.4)
```

Все временные расчёты — через `src/notifications/schedule.ts` на `dayjs` + плагины
`utc`/`timezone` (dayjs уже в зависимостях). Чистые функции:

```ts
nextDailySlot(hour: number, from: number, tz: string): number;
nextWeeklySlot(hour: number, from: number, tz: string): number;   // ближайший понедельник
nextMonthlySlot(hour: number, from: number, tz: string): number;  // ближайшее 1-е число
isQuietHour(ts: number, tz: string): boolean;
shiftOutOfQuietHours(ts: number, tz: string): number;             // → ближайшие 08:00
localDayKey(ts: number, tz: string): string;                      // 'YYYY-MM-DD'
```

### 5.3. Доставка (раз в 5 секунд)

```
notifications.where('status','==','pending')
             .where('nextAttemptAt','<=',now)
             .orderBy('nextAttemptAt')
             .limit(NOTIFY_DELIVERY_BATCH)

для каждого задания:
  1. now - runAt > NOTIFY_STALE_AFTER_MS  → skipped('stale')
  2. перечитать профиль:
       !enabled | !types[type] | status in (blocked, unreachable) → skipped('disabled')
  3. isQuietHour(now) → nextAttemptAt = shiftOutOfQuietHours(now); continue
  4. суточная капа: если sentDay === сегодня && sentCount >= NOTIFY_MAX_PER_USER_PER_DAY
       → digest/weekly/monthly: skipped('daily_cap')
         budget/lifecycle:      отложить на завтра 09:00
  5. отрендерить текст + клавиатуру по payload и language
  6. если introSentAt пуст — добавить пояснительный хвост и кнопку «⚙️ Настроить»
  7. sendMessage → status = 'sent', messageId, sentAt;
     профиль: sentCount++, sentDay, lastSentAt, telegram.status = 'reachable',
              introSentAt при первой отправке
  8. записать telegramMessages/{chatId}_{messageId} для работы кнопок
```

Троттлинг: не более `NOTIFY_SEND_RATE_PER_SEC` отправок в секунду суммарно и не чаще
одной в секунду в один чат (в рамках прохода группировать по `chatId`).

Обработка ошибок Bot API:

| Ответ | Действие |
|---|---|
| `429` + `parameters.retry_after` | `nextAttemptAt = now + retry_after*1000 + jitter(0..1000)`, `attempts` **не** увеличивать |
| `403 bot was blocked by the user` | `telegram.status = 'blocked'`; текущее и все `pending` задания пользователя → `cancelled` |
| `403 bot can't initiate conversation` | `telegram.status = 'unreachable'`; то же |
| `400 chat not found` / `user is deactivated` | `telegram.status = 'unreachable'`, `cancelled` |
| `5xx`, сеть, таймаут | `attempts++`, `nextAttemptAt = now + min(3600s, 2s * 2^attempts)`; при `attempts >= NOTIFY_MAX_ATTEMPTS` → `failed` |

Возврат в строй: когда пользователь пишет боту `/start` или любое сообщение (обработчик из
первого ТЗ), сбрасывать `telegram.status = 'reachable'`, `lastError = null` и обновлять `chatId`.

### 5.4. Бюджетные проверки — по событию

`scheduleBudgetCheck(uid)` вызывается после успешного создания/изменения транзакции:

```
docId = sha256(`budget_check:${uid}`)
create({ type: 'budget_check', runAt: now + 5 мин, ... })
ALREADY_EXISTS → ничего не делать (дебаунс)
```

Планировщик отдельно выбирает `type === 'budget_check'` с наступившим `runAt`, считает бюджеты
и порождает уже настоящие задания `budget_80` / `budget_100`, после чего удаляет служебное.
Вызов из HTTP-пути — строго fire-and-forget: ошибка не должна ломать ответ на создание транзакции.

---

## 6. Контент

Общие правила рендера: `parse_mode: 'HTML'`, экранирование `&<>` во всех пользовательских
строках, суммы с неразрывными пробелами, названия дефолтных категорий — через
`src/telegram/categoryAliases.ts` на языке пользователя. Максимум ~3500 символов на сообщение.

### 6.1. Утренний дайджест (`digest`)

Собирается на локальный день. Секции в фиксированном порядке, каждая появляется только при
наличии данных. **Нет ни одной секции → задание не создаётся.**

| Секция | Условие |
|---|---|
| 💳 Подписки | `isActive` и `nextBillingDate` попадает в сегодня или завтра |
| 💰 Долги | `!isPaid` и `dueDate` сегодня, просрочен, или через 3 дня |
| 📅 Планы | `plannedAppliesToDay(pe, сегодня)` и видимость ≠ `hidden` |
| 🏦 Кредитка | `cardType === 'credit'`, `dueDay` = сегодня или через 2 дня, `balance > 0` |
| 🏛 Депозиты | `endDate` через 7 или 1 день; либо `showInterest` и `calcRemainingInterest > 0` и наступил период капитализации |
| 💵 Зарплата | `salarySources[].day` = сегодняшнее число |
| 🎂 Дни рождения | `familyMembers[].birthday` (день+месяц) сегодня или через 3 дня |
| 🎯 Цели | `deadline` через 7 дней и `savedAmount < targetAmount` |

```
☀️ Доброе утро! Сегодня 2 августа

💳 Списываются подписки
· Netflix — 120 000 сум
· Spotify — 60 000 сум

💰 Долг
· Вернуть Азизу 500 000 сум — сегодня

📅 Запланировано
· Аренда — 3 000 000 сум

🎂 Через 3 дня день рождения: Амир (сын)

[💳 Оплатить Netflix] [💳 Оплатить Spotify]
[💰 Погасить долг]
[📱 Открыть Pulim] [⚙️ Настроить]
```

Ограничения: максимум 8 строк-пунктов суммарно, дальше «… и ещё N» + кнопка «📱 Открыть Pulim»;
максимум 6 кнопок действия.

### 6.2. Вечерний итог (`evening`, 21:00, opt-in)

Только если сегодня были транзакции без `source === 'transfer'`.

```
🌙 Итог дня

Потрачено: 145 000 сум · 4 операции
🍔 Еда 80 000 · 🚗 Транспорт 45 000 · 🛍 Покупки 20 000

За август: 3 200 000 из 4 000 000 (80%)

[📱 Открыть Pulim]
```

### 6.3. Недельный отчёт (`weekly`, понедельник)

Период — прошлая неделя, пн–вс, локально. Суммы — только UZS-эквивалент (`amount` для UZS,
`baseAmount` для остальных; транзакции без `baseAmount` не суммируются, но их количество
показывается строкой «N операций без курса»). Возвраты (`source === 'return'`) вычитаются из
расходов своей категории, переводы исключены — правило один в один как в
`pulim-ui-v2/src/pages/Transactions.tsx:655`.

```
📊 Неделя 27 июля — 2 августа

Расходы: 1 240 000 сум (−12% к прошлой неделе)
Доходы: 0
Записано операций: 23

Топ категорий:
1. 🍔 Еда — 520 000
2. 🚗 Транспорт — 310 000
3. 🛍 Покупки — 210 000

Сильнее всего выросло: 🎮 Развлечения +180%

[📊 Графики] [📱 Открыть Pulim]
```

Если за неделю не было ни одной операции — вместо цифр одна строка
«За неделю ни одной записи. Записать трату можно прямо здесь: <code>обед 45к</code>»
(ссылка на фичу из первого ТЗ). Это единственный «поведенческий» намёк в v1.

### 6.4. Месячный отчёт (`monthly`, 1-го числа)

```
📈 Итоги июля

Доходы: 8 400 000 сум
Расходы: 6 150 000 сум
Остаток: +2 250 000 сум

Топ категорий:
1. 🍔 Еда — 1 850 000 (30%)
2. 🏠 Жильё — 1 500 000 (24%)
3. 🚗 Транспорт — 890 000 (14%)

Бюджеты: 3 из 5 в норме
⚠️ 🍔 Еда превышен на 240 000

Подписки за месяц: 420 000 сум

💡 Разбор
<2–3 предложения от AI>

[📊 Графики] [📱 Открыть Pulim]
```

Блок «💡 Разбор» — **только для Premium** (`getIsPremium`). Реализация в
`src/notifications/monthlyAi.ts`: отдельный компактный промпт по образцу `buildForecastPrompt`,
strict JSON Schema `{ insight: string, tip: string }`, модель `NOTIFY_MONTHLY_AI_MODEL`,
`store: false`, `recordAiUsage({ feature: 'monthly_report' })`. Сбой AI не отменяет отчёт —
блок просто не выводится.

Free-пользователю вместо блока — одна строка и кнопка:
«💡 Персональный разбор месяца доступен в Premium» + `[💎 Premium]`.

### 6.5. Бюджеты (`budget_80`, `budget_100`)

Расчёт потраченного по категории повторяет `pulim-ui-v2/src/pages/Home.tsx:143`:
транзакции текущего месяца, `currency === 'UZS'`, `source !== 'transfer'`, возвраты вычитаются.

```
⚠️ Бюджет на исходе

🍔 Еда: 1 200 000 из 1 500 000 (80%)
Осталось 300 000 сум на 12 дней — это 25 000 в день.

[📱 Открыть Pulim]
```

```
🔴 Бюджет превышен

🍔 Еда: 1 740 000 из 1 500 000 (+240 000)

[📱 Открыть Pulim]
```

Каждый порог — не чаще одного раза на категорию в календарный месяц (дедуп-ключ).

### 6.6. Жизненный цикл (`lifecycle`)

| Тип | Условие | Суть |
|---|---|---|
| `trial_3d` | `isTrial`, `premiumUntil` через 3 дня | Что именно перестанет работать + `[💎 Оформить Premium]` |
| `trial_1d` | `isTrial`, `premiumUntil` завтра | То же, короче и конкретнее |
| `premium_expired` | `premiumUntil` прошёл в последние 24 ч | Что отключилось, данные сохранены + `[💎 Продлить]` |
| `onboarding` | 24–48 ч после `trialGrantedAt`, при `onboardingComplete !== true` или отсутствии карт | Один раз. Что настроить за 2 минуты + `[📱 Открыть Pulim]` |

Пример `trial_3d`:

```
💎 Триал заканчивается через 3 дня

После 5 августа станут недоступны: бюджеты, долги, депозиты,
накопления, планирование, расширенные графики и запись трат
сообщением в этом чате. Все данные останутся на месте.

[💎 Оформить Premium] [📱 Открыть Pulim]
```

### 6.7. Пояснительный хвост первого сообщения

К самому первому уведомлению в жизни пользователя добавляется:

```
—
Это напоминания Pulim. Отключить или настроить: /settings
```

и кнопка `[⚙️ Настроить уведомления]`. Далее фиксируется `introSentAt`.

---

## 7. Действия из уведомления (два тапа)

Переиспользуется протокол `callback_data` и коллекция `telegramMessages` из первого ТЗ
(индексы вместо id, проверка владельца, обязательный `answerCallbackQuery`).

| Шаг 1 | Шаг 2 | Итог |
|---|---|---|
| `paysub:<i>` | Экран: сумма, название, кнопки карт → `paysubok:<i>:<k>` | `paySubscription(uid, subId, cardId)` |
| `paydebt:<i>` | Экран: остаток долга, кнопки «Весь остаток» / «Другая сумма» → кнопки карт → `paydebtok:<i>:<k>` | `payDebt(uid, debtId, { amount, accountId })` |
| `addplan:<i>` | Экран: сумма, категория, кнопки карт → `addplanok:<i>:<k>` | `createTransaction` с `origin: 'telegram'` |

Правила:

1. **Никогда не списывать по одному нажатию.** Первый тап только показывает экран
   подтверждения с полной суммой и выбором счёта.
2. Карты предлагаются по тому же алгоритму, что в первом ТЗ (`resolve/card.ts`): фильтр по
   валюте, порядок по давности использования, отметка «не хватает средств».
3. Все деньги — только через существующие атомарные сервисы. Прямых записей нет.
4. Повторное нажатие после выполнения: состояние проверяется в `db.runTransaction()`
   (например, `nextBillingDate` уже сдвинут / `debt.isPaid`) → `answerCallbackQuery`
   «Уже оплачено», сообщение перерисовывается.
5. После выполнения исходное сообщение редактируется: строка получает ✅ и сумму,
   кнопка действия исчезает.

### 7.1. Команды бота

- `/settings` — карточка настроек уведомлений с инлайн-переключателями типов и слота времени;
  меняет `profile.notifications`, перерисовывает сообщение.
- `/stop` — `enabled = false`, все `pending` → `cancelled`, ответ с кнопкой «Включить обратно».
- `/start notify` (диплинк из Mini App) — включить уведомления, ответить подтверждением,
  выставить `telegram.status = 'reachable'`.

---

## 8. Изменения в `pulim-ui-v2`

### 8.1. Экран настроек уведомлений

Новый подраздел в `Settings.tsx` (`SettingsView` → `'notifications'`), по образцу существующих:

- главный тумблер «Уведомления в Telegram»;
- выбор времени: три чипа `08:00 / 09:00 / 20:00`;
- переключатели: события дня, итог дня (подпись «выключено по умолчанию»), отчёт за неделю,
  отчёт за месяц, бюджеты, подписка и триал;
- всё пишется через `PATCH /v1/profile/notifications`, оптимистично, с откатом при ошибке;
- строка состояния доставки:
  - `reachable` → «Уведомления приходят в Telegram»;
  - `blocked` → «Вы заблокировали бота. Разблокируйте, чтобы получать напоминания.»;
  - `unreachable` / `unknown` → кнопка «Включить в Telegram» на
    `https://t.me/{TELEGRAM_BOT_USERNAME}?start=notify`.

### 8.2. Баннер включения

Показывать на Home один раз (по образцу `TelegramLinkBanner.tsx`), если
`notifications.enabled === true`, но `telegram.status !== 'reachable'`. Кнопка ведёт на тот же
диплинк. Закрытие запоминается в профиле (`notificationsPromptDismissed: boolean`).

### 8.3. Прочее

- `src/types.ts` — тип `NotificationSettings` (зеркало серверного).
- Новый хук `useNotificationSettings` поверх `api.patch('/v1/profile/notifications')`
  с инвалидацией профиля.
- i18n: новые ключи **во все три файла** (`settings.notifications_*`, `home.notify_banner_*`),
  иначе `npm run check:i18n` упадёт.
- `VITE_TELEGRAM_BOT_USERNAME` в `.env.example`.

---

## 9. Наблюдаемость и защита

Логи (pino, существующий `utils/logger.ts`):

| Событие | Поля |
|---|---|
| `notify.planner.tick` | type, scanned, queued, skipped, durationMs |
| `notify.queued` | uid, type, dedupeKey |
| `notify.sent` | uid, type, messageId, latencyMs |
| `notify.skipped` | uid, type, skipReason |
| `notify.failed` | uid, type, attempts, err |
| `notify.blocked` | uid, reason (`blocked` / `unreachable`) |
| `notify.action` | uid, action, result |

Правила:

1. В логах — никаких сумм, названий категорий и имён; только идентификаторы и счётчики.
2. Суточная капа `NOTIFY_MAX_PER_USER_PER_DAY = 3` — жёсткая, включая все типы.
3. Тихие часы 22:00–08:00 действуют на **все** типы без исключений.
4. Массовый `403` (> 5% отправок за час) → `logger.error` с отдельным маркером: это сигнал,
   что что-то не так с ботом или контентом.
5. Планировщик не должен падать целиком из-за одного профиля: каждый пользователь
   обрабатывается в своём `try/catch`.

---

## 10. Тесты

Юнит (`vitest`, добавляется первым ТЗ) — только чистые функции:

- `schedule.test.ts` — слоты в Asia/Tashkent: переход через полночь, 1-е число, понедельник,
  тихие часы на границах 21:59 / 22:00 / 07:59 / 08:00, смена `digestHour`.
- `digest.test.ts` — сборка секций: пустой день даёт пустой список; подписка завтра попадает,
  послезавтра нет; просроченный долг попадает; ДР 29 февраля в невисокосный год.
- `weekly.test.ts` — агрегация: переводы исключены, возвраты вычтены, не-UZS без `baseAmount`
  не суммируются, деление на ноль при нулевой прошлой неделе.
- `budget.test.ts` — 79.9% не триггерит, 80.0% триггерит, 100% триггерит отдельно,
  повторный вызов в том же месяце не создаёт дубль.
- `backoff.test.ts` — задержки, потолок в час, переход в `failed` на 8-й попытке.

---

## 11. Критерии приёмки

| # | Сценарий | Ожидаемо |
|---|---|---|
| 1 | Пользователь с подпиской на завтра и долгом на сегодня | В 09:00 одно сообщение с двумя секциями и кнопками |
| 2 | Пользователь без событий на сегодня | Сообщение **не отправлено**, задание не создано |
| 3 | Тап «Оплатить Netflix» → выбор карты → «Подтвердить» | Одна транзакция `source: 'subscription'`, баланс карты уменьшен, `nextBillingDate` сдвинут, строка в сообщении получила ✅ |
| 4 | Повторный тап «Подтвердить» | «Уже оплачено», второй транзакции нет |
| 5 | Планировщик отработал дважды за один день | Ровно одно задание `digest` (проверить по `dedupeKey`) |
| 6 | Пользователь заблокировал бота | Первая же отправка → `telegram.status = 'blocked'`, все `pending` → `cancelled`, попыток больше нет |
| 7 | Пользователь разблокировал и написал `/start` | Статус `reachable`, со следующего дня уведомления идут |
| 8 | Пользователь никогда не нажимал Start | `unreachable`, в Mini App показан баннер «Включить в Telegram» |
| 9 | Трата, доводящая категорию до 80% бюджета | Через ~5 минут уведомление; следующая трата в том же месяце нового не порождает |
| 10 | Превышение того же бюджета | Отдельное уведомление `budget_100` (порог другой) |
| 11 | Понедельник, слот 09:00 | Недельный отчёт с корректными суммами; переводы не попали в расходы; возвраты вычтены |
| 12 | 1-е число, Premium | Месячный отчёт с блоком «💡 Разбор» |
| 13 | 1-е число, free | Тот же отчёт без AI-блока, со строкой апселла и кнопкой Premium |
| 14 | OpenAI недоступен 1-го числа | Отчёт отправлен без блока разбора, ошибка в логах |
| 15 | Триал заканчивается через 3 дня | Одно уведомление; повторно в тот же день не приходит |
| 16 | Выключить главный тумблер в настройках | Ничего не приходит; `pending`-задания отменены |
| 17 | Выключить только «отчёт за неделю» | Дайджест приходит, недельный — нет |
| 18 | Сменить слот с 09:00 на 20:00 | `nextDigestAt` пересчитан на сегодня/завтра 20:00 |
| 19 | Задание пролежало 7 часов из-за сбоя | `skipped('stale')`, устаревшие цифры не отправлены |
| 20 | Пользователь получил 3 сообщения за день, приходит четвёртое | Дайджест/отчёт — `skipped('daily_cap')`; бюджетное — перенесено на завтра |
| 21 | Событие выпало на 23:30 | Отправка отложена до 08:00 |
| 22 | Старый профиль без `notifications` | После `bootstrap()` или скрипта миграции появляются дефолты и он попадает в рассылку |
| 23 | Воркер убит на середине прохода | После рестарта задания доотправляются, дублей нет |
| 24 | `NOTIFICATIONS_ENABLED=false` | Воркер стартует, ничего не шлёт, API работает как прежде |

Технические:

- HTTP-путь создания транзакции не замедлился: `scheduleBudgetCheck` асинхронный и его сбой
  не влияет на ответ.
- Никакие расчёты Mini App не изменились — уведомления только читают данные,
  а действия из чата идут через уже существующие атомарные сервисы.

Команды проверки:

```bash
# pulim-api-v2
npm run typecheck && npm run lint && npm run build && npm run test
node dist/worker.js   # должен подняться и залогировать старт обоих циклов
```

```bash
# pulim-ui-v2
npm install --legacy-peer-deps
npx tsc --noEmit -p tsconfig.app.json && npm run check:i18n && npm run build && npx eslint src/
```

Две ошибки eslint в UI (`react-refresh/only-export-components` в `PremiumLock.tsx` и
`context.tsx`) существовали до задачи — не регрессия, но новых добавлять нельзя.

---

## 12. Что НЕ входит в v1

- Web Push, e-mail, SMS.
- «Вы давно не записывали трат» и прочие поведенческие нудж-и (кроме одной строки в недельном
  отчёте при нулевой активности) — вернуться к ним, когда наберётся статистика по блокировкам.
- Обнаружение необычных трат, антифрод-подобные алерты.
- Персонализация времени по фактической активности пользователя.
- A/B-тесты формулировок, сегментация, маркетинговые рассылки «всем».
- Уведомления о движениях по депозиту сверх дайджеста, отчёты по конкретным целям.

---

## 13. Порядок работ

1. **Каркас воркера.** `worker.ts`, два пустых цикла, graceful shutdown, env, скрипты,
   `NOTIFICATIONS_ENABLED`. Проверка: процесс поднимается и логирует тики.
2. **Модель настроек.** `profile.notifications`, дефолты в `bootstrap()`,
   `PATCH /v1/profile/notifications`, скрипт бэкфилла. Проверка: настройки читаются и пишутся.
3. **Очередь и доставка.** Коллекция `notifications`, индекс, `delivery.ts` с бэкоффом,
   обработкой 403/429, тихими часами и суточной капой. Проверка: вручную положенное в очередь
   задание доходит до чата, а при блокировке бота отменяется.
4. **Дайджест.** `collectors/digest.ts` + рендер + планирование по `nextDigestAt`.
   Проверка: сценарии 1, 2, 5.
5. **Действия из чата.** `actions.handler.ts`: оплата подписки, погашение долга, запись плана.
   Проверка: сценарии 3, 4.
6. **Бюджеты.** `scheduleBudgetCheck` + сборщик порогов. Проверка: сценарии 9, 10.
7. **Отчёты.** Недельный, затем месячный; AI-блок для Premium последним.
   Проверка: сценарии 11–14.
8. **Жизненный цикл.** Триал, истёкший Premium, онбординг. Проверка: сценарий 15.
9. **UI:** экран настроек, баннер, i18n, хук. Проверка: сценарии 8, 16, 17, 18.
10. **Приёмка** по таблице раздела 11, обновление `README.md` обоих репозиториев и
    `PROJECT_CONTEXT.md`, включение TTL-политик и создание композитного индекса.

Коммиты — по этапам; каждый этап собирается и проходит проверки.
