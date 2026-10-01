# ТЗ: проактивные напоминания и отчёты в Telegram

**Версия:** 2.0 · **Дата:** 2026-09-02 · **Исполнитель:** AI Codex
**Репозитории:** `pulim-api-v2` (основной объём), `pulim-ui-v2` (один тумблер и баннер)

> **Версия 2.0 переписана под текущее состояние кода.** Первое ТЗ
> ([TZ-telegram-quick-entry.md](TZ-telegram-quick-entry.md)) реализовано и с тех пор
> ушло далеко вперёд: быстрая запись стала доступна и бесплатным пользователям,
> появились идемпотентные денежные операции, триал стал семидневным и запускается
> кнопкой, онбординг перестал быть первым запуском. Все расчёты и ссылки ниже
> сверены с кодом на 2026-09-02.

---

## 0. Задача

Pulim ничего не отправляет пользователю и живёт только пока о нём помнят. Нужно
раз в день, по делу и только при наличии повода напоминать о себе в Telegram:
события дня, отчёты за неделю и месяц, предупреждения о бюджетах и события
подписки.

**Главный риск фичи — блокировка бота.** Заблокированный бот перестаёт доставлять
всё, включая быструю запись транзакций текстом, которой пользуются в том числе
бесплатные пользователи. Поэтому «не отправлять, если нечего сказать», склейка
всего в одно сообщение в день и лёгкое отключение — обязательные требования, а не
украшения.

---

## 1. Что уже есть

### 1.1. Инфраструктура

| Компонент | Состояние |
|---|---|
| Web Push / FCM | **Нет.** `messagingSenderId` в конфиге есть, но `firebase/messaging`, `firebase-messaging-sw.js` и VAPID отсутствуют |
| Telegram-доставка | Клиент Bot API `src/telegram/client.ts`, `profiles.telegramChatIds[]`, коллекция `telegramUsers`, резолвер `telegramId → uid` (`src/telegram/context.ts`) |
| Фоновые циклы | **Есть.** `src/server.ts` уже поднимает `startFxQueue()` и `setInterval(recoverTelegramUpdates, 30_000)` — прецедент внутрипроцессных таймеров |
| Отдельный процесс-воркер | **Нет.** Ни Dockerfile, ни compose в этом репозитории; деплой через pm2 |
| Образец воркера с очередью и бэкоффом | `pulim-payment-api/src/worker.ts` + `src/services/outbox.service.ts` |
| Паттерн claim с lease | **Есть** — `claimUpdate` в `src/telegram/dedupe.repository.ts:27` |
| Идемпотентные денежные операции | **Есть** — `telegramOperationMarkerRef`, `createTelegramTransactionOnce`, `createTelegramTransferOnce` (`src/services/transaction.service.ts`), `createTelegramDebtOnce`, `payTelegramDebtOnce` (`src/services/debt.service.ts`) |
| Тесты | `vitest`, 9 файлов в `tests/telegram/` |
| `firestore.indexes.json` / `firebase.json` | Добавляются в API-репозиторий вместе с фичей; композитные индексы версионируются в git, TTL по-прежнему включается в консоли Firebase |

### 1.2. Источники поводов

| Данные | Повод | Готовая логика |
|---|---|---|
| `subscriptions.nextBillingDate`, `cycle`, `isActive` | Списание сегодня/завтра | `paySubscription` в `services/subscription.service.ts` |
| `debts.dueDate`, `isPaid`, `paidAmount`, `commission` | Вернуть долг / вам должны | `payTelegramDebtOnce`, `calcDebtTotal` в `domain/debt.ts` |
| `cards.dueDay`, `cardType: 'credit'` | Платёж по кредитке | — |
| `deposits.endDate`, `interestPaidOut`, `showInterest` | Закрытие, накопленные проценты | `domain/deposit.ts:calcRemainingInterest` |
| `savingsGoals.deadline`, `savedAmount` | Дедлайн цели близко | — |
| `budgets` + транзакции месяца | 80% / превышение | расчёт продублирован из `pulim-ui-v2/src/pages/Home.tsx:141` |
| `subscription.*` + `domain/trial.ts:getTrialBlockCode` | Триал не начат, заканчивается, истёк | `startTrial` в `services/profile.service.ts` |
| `cards` (пусто через 2 дня) | Аккаунт не настроен | — |
| `prompts/buildContext.ts:buildForecastPrompt` | AI-разбор месяца и недели | образец компактного промпта |

**Сознательно не используем:** `planned_expenses` (экран «Календарь» скрыт из навигации),
`profile.salarySources[].day` и `profile.familyMembers[].birthday` (онбординг перестал
быть первым запуском, поля почти у всех пусты), `profile.onboardingComplete` (по той же
причине условие `!== true` истинно почти для всех).

### 1.3. Ограничения Telegram, определяющие дизайн

1. **Бот не может написать первым тому, кто не нажимал Start.** Открытие Mini App
   разрешения не даёт. `sendMessage` вернёт `403 Forbidden: bot can't initiate
   conversation with a user`.
2. **Пользователь может заблокировать бота:** `403 Forbidden: bot was blocked by the user`.
   Продолжать слать нельзя — Telegram начнёт ограничивать бота целиком.
3. **Лимиты частоты:** ~30 сообщений/сек суммарно, ~1 сообщение/сек в один чат.
   Превышение → `429` с полем `parameters.retry_after`.
4. `callback_data` — не более 64 байт. Поэтому в кнопках только индексы, а не
   идентификаторы документов (как уже сделано в `callback.handler.ts`).

### 1.4. Принятые решения (не пересматривать)

| Вопрос | Решение |
|---|---|
| Канал | Только Telegram. SMS через Eskiz — не цель v1 |
| Планировщик | Отдельный процесс-воркер `dist/worker.js` под pm2; для dev и простых конфигураций — режим `NOTIFY_EMBEDDED=true` внутри API |
| Частота | **Максимум одно плановое сообщение в сутки** плюс событийные бюджетные предупреждения |
| Время | Фиксированные 10:00 Asia/Tashkent. Пользователь время **не выбирает** |
| Настройки для пользователя | **Один тумблер** «Напоминания в Telegram». Никаких переключателей по типам |
| Согласие | Включено сразу, отключается тумблером, командой `/stop` или кнопкой «🔕 Отключить» под сообщением |
| Доступ | Всем. Данные премиум-функций (долги, депозиты, бюджеты, цели) напоминаем и бесплатным — с одной строкой апселла |
| Premium сверх бесплатного | AI-разбор месяца, AI-строка в недельном отчёте, разбор «куда ушло» в бюджетном предупреждении |
| Действия из чата | Разрешены, строго в два тапа с подтверждением, только через идемпотентные сервисы |
| Вечерний итог дня | **Не делаем** |
| Персональный часовой пояс | Не в v1 |

---

## 2. Архитектура

```
┌─ pulim-api-v2 ────────────────────────────────────────────────┐
│                                                               │
│  server.ts (HTTP)                    worker.ts (pm2-процесс)  │
│    /v1/*                               planner  каждые 15 мин │
│    /telegram/webhook                   delivery каждые 5 сек  │
│         │                                    │                │
│         └──────── Firestore ─────────────────┘                │
│              notifications      очередь + журнал сообщений    │
│              notificationTasks  служебные задачи (бюджеты)    │
│              notificationState  что уже говорили пользователю │
│              profiles.notifications  тумблер и метки          │
└───────────────────────────────────────────────────────────────┘
```

**Ключевое отличие от версии 1.0 — один ежедневный проход на пользователя.**
Вместо пяти независимых расписаний (дайджест, вечер, неделя, месяц, жизненный цикл)
планировщик раз в сутки в 10:00 по местному времени собирает **одно** сообщение,
склеивая в него все актуальные блоки. Это следствие решения «максимум одно сообщение
в день» и «один тумблер»: разные расписания всё равно пришлось бы склеивать, а профиль
пользователя при таком проходе читается один раз вместо пяти.

**Почему два цикла.** Планировщик читает много данных на пользователя (подписки,
долги, карты, депозиты, транзакции) — это медленно. Доставка обязана быть быстрой и
соблюдать лимиты Telegram. Одна тяжёлая выборка не должна задерживать рассылку.

**Почему отдельный процесс.** Рассылка не конкурирует за event loop с запросами
пользователей, а рестарт API не роняет наполовину выполненный проход планировщика.

### 2.1. Новые файлы

```
src/worker.ts                                   точка входа воркера
src/notifications/types.ts                     типы payload, очереди и состояния
src/notifications/loops.ts                     общие циклы standalone / embedded
src/notifications/planner.ts                    ежедневный проход + задачи
src/notifications/delivery.ts                   цикл доставки
src/notifications/backoff.ts                    retry/backoff для Bot API
src/notifications/queue.repository.ts           коллекции notifications / notificationTasks
src/notifications/state.repository.ts           notificationState — карта уже сказанного
src/notifications/settings.ts                   чтение и дефолты profile.notifications
src/notifications/schedule.ts                   слоты и тихие часы в Asia/Tashkent (чистая)
src/notifications/collectors/daily.ts           сбор блоков одного дня (оркестратор)
src/notifications/collectors/events.ts          подписки, долги, кредитка, депозиты, цели
src/notifications/collectors/weekly.ts          недельный блок
src/notifications/collectors/monthly.ts         месячный блок
src/notifications/collectors/lifecycle.ts       триал, Premium, «нет карт»
src/notifications/collectors/budget.ts          пороги бюджетов
src/notifications/render/blocks.ts              payload → текст
src/notifications/render/keyboard.ts            payload → инлайн-клавиатура
src/notifications/i18n.ts                       строки уведомлений с параметрами
src/notifications/format.ts                     деньги, даты, склонения
src/notifications/ai.ts                         AI-разбор месяца и недели (Premium)
src/telegram/handlers/actions.handler.ts        кнопки «Оплатить», «Погасить», «Отключить»
src/routes/notificationSettings.routes.ts       PATCH /v1/profile/notifications
scripts/backfill-notification-settings.ts       разовая миграция профилей
```

Тесты:

```
tests/notifications/schedule.test.ts
tests/notifications/events.test.ts
tests/notifications/weekly.test.ts
tests/notifications/monthly.test.ts
tests/notifications/lifecycle.test.ts
tests/notifications/budget.test.ts
tests/notifications/dedupe.test.ts
tests/notifications/backoff.test.ts
tests/notifications/format.test.ts
```

### 2.2. Изменения в существующих файлах

| Файл | Изменение |
|---|---|
| `package.json` | Скрипты `"worker": "node dist/worker.js"`, `"dev:worker": "tsx watch src/worker.ts"` |
| `src/config/env.ts` | Переменные из 2.3 |
| `src/telegram/client.ts` | **Обязательно:** `callTelegram` заменить на версию, бросающую `TelegramApiError` с полями `status`, `errorCode`, `description`, `retryAfter`. Сейчас бросается безликий `new Error(...)`, из-за чего обработка `429`/`403` невозможна. Существующие вызовы ловят ошибку как `Error` и продолжат работать |
| `src/telegram/client.ts` | В `setMyCommands` добавить `/stop` |
| `src/telegram/dispatcher.ts` | Передавать в `handleCommand` аргумент команды: сейчас `message.text.split(/\s/, 1)[0]` отбрасывает payload и `/start notify` не отличим от `/start` |
| `src/telegram/handlers/command.handler.ts` | Обработка `/start notify` (включить уведомления, `telegram.status = 'reachable'`) и `/stop` |
| `src/telegram/handlers/callback.handler.ts` | Подключить `actions.handler.ts` перед разбором черновиков |
| `src/telegram/messages.repository.ts` | В `kind` добавить `'notification'`; в `items` — необязательные `subscriptionId`, `debtId`; поля обратно совместимы |
| `src/services/subscription.service.ts` | Добавить `payTelegramSubscriptionOnce` (раздел 7.2). Существующий `paySubscription` не трогать |
| `src/services/profile.service.ts` | В `bootstrap()` — `ensureNotificationDefaults(uid)`, который также добавляет отсутствующий `createdAt` |
| `src/services/profile.service.ts` | В `startTrial()` — `void queueTrialStarted(uid)` (fire-and-forget, ошибку глотать) |
| `src/services/transaction.service.ts` | `void scheduleBudgetCheck(uid)` (fire-and-forget) после `createTelegramTransactionOnce`, `createTransaction`, `updateTransaction`, `deleteTransaction`, **`returnTransaction`, `updateReturn`** — полный список путей в 5.4 |
| `src/domain/types.ts` | `UserProfile.createdAt?: number`, `UserProfile.notifications?: NotificationSettings` |
| `src/domain/schemas.ts` | `notificationSettingsPatchSchema` |
| `src/routes/index.ts` | Смонтировать `notificationSettings.routes.ts` |
| `README.md`, `.env.example` | Воркер, переменные, индексы, TTL, запуск под pm2 |

### 2.3. Переменные окружения

```dotenv
# ── Notifications ────────────────────────────────────────────────────────────
NOTIFICATIONS_ENABLED=false                   # dark launch; включить после индексов и бэкфилла
NOTIFY_EMBEDDED=false                    # true — поднять циклы внутри server.ts
NOTIFY_TIMEZONE=Asia/Tashkent
NOTIFY_DIGEST_HOUR=10                    # локальный час ежедневного сообщения

NOTIFY_PLANNER_INTERVAL_MS=900000        # 15 минут
NOTIFY_DELIVERY_INTERVAL_MS=5000         # 5 секунд
NOTIFY_PLANNER_BATCH=200                 # профилей за проход
NOTIFY_DELIVERY_BATCH=50                 # заданий за проход

NOTIFY_QUIET_START_HOUR=22               # с 22:00 не шлём
NOTIFY_QUIET_END_HOUR=8                  # до 08:00 не шлём
NOTIFY_SAFETY_MAX_PER_USER_PER_DAY=6     # аварийный потолок, в интерфейсе не отражён
NOTIFY_STALE_AFTER_MS=21600000           # 6 часов активного ожидания
NOTIFY_MAX_ATTEMPTS=8
NOTIFY_SEND_RATE_PER_SEC=25              # < 30, запас на ответы вебхука
NOTIFY_LEASE_MS=120000                   # аренда задания на время отправки

NOTIFY_BUDGET_DEBOUNCE_MS=300000         # 5 минут после последней транзакции
NOTIFY_TRIAL_AVAILABLE_DAYS=3            # через сколько дней предложить триал
NOTIFY_TRIAL_AVAILABLE_REPEAT_DAYS=21    # повтор предложения
NOTIFY_NO_CARDS_DAYS=2                   # через сколько дней напомнить настроить счёт

NOTIFY_AI_ENABLED=true
NOTIFY_AI_MODEL=gpt-5.4-mini
NOTIFY_AI_MAX_OUTPUT_TOKENS=1200
NOTIFY_AI_TIMEOUT_MS=20000
```

Валидация в `env.ts`: при `NOTIFICATIONS_ENABLED=true` обязательны `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_BOT_USERNAME`, `WEB_APP_URL`; `NOTIFY_DIGEST_HOUR` должен лежать в
`[NOTIFY_QUIET_END_HOUR, NOTIFY_QUIET_START_HOUR)`; `NOTIFY_TIMEZONE` — валидная зона IANA
(проверять так же, как уже проверяется `TELEGRAM_DEFAULT_TIMEZONE`).

### 2.4. Индексы Firestore и TTL

Композитные индексы описываются в `firestore.indexes.json` и деплоятся через Firebase
CLI в выбранный проект. TTL-политики через конфиг не создаются: их нужно включить
вручную в консоли, как описано в `README.md`.

Композитные индексы:

| Коллекция | Поля |
|---|---|
| `notifications` | `status ASC`, `nextAttemptAt ASC` |
| `notifications` | `status ASC`, `leaseUntil ASC` — восстановление истёкших аренд |
| `notificationTasks` | `status ASC`, `runAt ASC` |
| `notificationTasks` | `status ASC`, `leaseUntil ASC` — восстановление зависших задач |
| `transactions` | `userId ASC`, `date ASC` — обязателен для недельного и месячного отчёта |

Запросы планировщика по профилям (`notifications.nextDailyAt <= now`) обходятся
автоматическими одиночными индексами: вложенные поля map индексируются по умолчанию.

TTL-политики по полю `expiresAt`: `notifications`, `notificationTasks`.
Существующие политики (`telegramUpdates`, `telegramOperations`, `telegramDrafts`,
`telegramMessages`, `telegramSessions`) остаются.

---

## 3. Модель настроек

### 3.1. `profile.notifications`

```ts
export interface NotificationSettings {
  /** Единственный пользовательский переключатель. По умолчанию true. */
  enabled: boolean;

  telegram: {
    chatId: string | null;          // канонический чат рассылки, строка как везде в коде
    status: 'unknown' | 'reachable' | 'unreachable' | 'blocked';
    lastError: string | null;
    checkedAt: number;
  };

  // Управляются только сервером
  nextDailyAt: number;              // следующий проход, 10:00 локально
  introSentAt: number | null;       // когда отправили первое пояснительное сообщение
  sentDay: string;                  // 'YYYY-MM-DD' для аварийного потолка
  sentCount: number;
  reservedDay?: string;             // атомарная бронь до фактической отправки
  reservedCount?: number;
  lastSentAt: number | null;
}
```

`chatId` берётся как последний элемент `profile.telegramChatIds`, приведённый к строке,
а при любом обращении пользователя к боту перезаписывается на актуальный
`message.chat.id`.

Клиент видит и меняет **только** `enabled`. Всё остальное — служебное.

### 3.2. `notificationState/{uid}` — что пользователю уже говорили

```ts
{
  userId: string;
  seen: Record<string, number>;   // ключ повода → когда отправили
  trialAvailableSentCount: number;
  lastTrialAvailableAt: number | null;
  weeklyEmptyStreak: number;
  updatedAt: number;
}
```

Один документ на пользователя вместо россыпи маркеров: планировщик читает его один
раз за проход, доставка дописывает ключи **только после успешной отправки** — иначе
неотправленное сообщение «сожгло» бы повод. При каждой записи из `seen` выкидываются
записи старше 90 дней. Счётчик предложений триала и серия пустых недель хранятся
отдельно и не очищаются вместе с `seen`: это постоянные ограничения продукта, а не
временные ключи дедупликации.

### 3.3. `profile.createdAt`

Нужен для поводов «триал не начат» и «нет карт», а сейчас в профиле есть только
`updatedAt`. `ensureNotificationDefaults(uid)` в `bootstrap()` в транзакции
проставляет его вместе с настройками, если поля нет. Скрипт бэкфилла ставит
существующим профилям их `updatedAt`.

### 3.4. Дефолты и обратная миграция

**Критично:** Firestore не возвращает документы, у которых запрашиваемого поля нет.
Профили, созданные до этой фичи, не имеют `notifications.nextDailyAt` и в выборку
планировщика не попадут никогда.

1. `ensureNotificationDefaults(uid)` вызывается из `bootstrap()` (он дёргается при
   каждом входе) — идемпотентно проставляет дефолты, если `profile.notifications`
   отсутствует. `nextDailyAt` — ближайшие 10:00.
2. `scripts/backfill-notification-settings.ts` — разовый прогон по всем профилям
   батчами по 400: проставляет `createdAt` и дефолты `notifications` тем, у кого их нет.
   Запускается вручную один раз после деплоя, описывается в `README.md`.

### 3.5. Эндпоинт настроек

```
PATCH /v1/profile/notifications
{ "enabled": true }
→ 200 { ...NotificationSettings }
```

Схема `.strip()`: клиент не может писать `telegram.*`, `nextDailyAt`, `sentCount`,
`introSentAt`. При `enabled: false` сервер переводит все `pending`-задания
пользователя в `cancelled` и ставит `nextDailyAt = 0`, чтобы отключённые профили
не попадали в ежедневную выборку. При `enabled: true` — пересчитывает `nextDailyAt`
на ближайшие 10:00.

---

## 4. Очередь `notifications`

Одна коллекция служит и очередью, и журналом отправленного, и защитой от дублей.

```ts
{
  userId: string;
  chatId: string;
  type: 'daily' | 'budget_80' | 'budget_100' | 'trial_started';
  dedupeKey: string;
  status: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'cancelled';

  runAt: number;
  staleAt: number;               // абсолютный дедлайн актуальности
  deferredUntil: number | null;  // новый слот после тихих часов
  nextAttemptAt: number;
  leaseUntil: number | null;
  attempts: number;
  lastError: string | null;
  skipReason: string | null;

  payload: DailyPayload | BudgetPayload | TrialStartedPayload;   // раздел 6
  stateKeys: string[];           // ключи для notificationState, пишутся при успехе

  messageId: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  expiresAt: Timestamp;          // createdAt + 90 дней
}
```

**Идентификатор документа = `sha256(dedupeKey).slice(0, 32)`**, запись строго через
`create()`. Повторный проход планировщика получит `ALREADY_EXISTS` и ничего не
продублирует.

| Тип | Ключ дедупликации |
|---|---|
| `daily` | `daily:{uid}:{YYYY-MM-DD}` |
| `budget_80` / `budget_100` | `budget{80\|100}:{uid}:{categoryId}:{YYYY-MM}` |
| `trial_started` | `trial_started:{uid}` |

### 4.1. `notificationTasks` — служебные задачи

Отдельная коллекция, чтобы служебная задача физически не могла попасть в выборку
доставки.

```ts
{ userId: string; type: 'budget_check'; status: 'pending' | 'processing' | 'done';
  version: number; claimedVersion?: number; runAt: number; rerunAt: number | null;
  leaseUntil: number | null; createdAt: number; updatedAt: number;
  expiresAt: Timestamp }
```

Идентификатор документа = `sha256('budget_check:' + uid)`. Каждая транзакция
увеличивает `version` и переносит `runAt` на `now + debounce`, поэтому задача
выполняется через пять минут **после последнего** изменения, а не после первого.
Если изменение пришло во время обработки, сохраняется `rerunAt`; завершивший старую
версию воркер снова переводит задачу в `pending` и не теряет новое изменение.

---

## 5. Воркер

### 5.1. `src/worker.ts`

Структура копируется из `pulim-payment-api/src/worker.ts`: два `setInterval`, защита
от наложения прогонов (если предыдущий промис не завершён — тик пропускается),
корректный `SIGINT`/`SIGTERM` с ожиданием текущих прогонов, `logger` из существующего
`utils/logger.ts`. В standalone-воркере таймеры держат процесс живым; только embedded-
таймеры получают `unref()`, чтобы не влиять на штатное завершение API.

При `NOTIFICATIONS_ENABLED=false` воркер стартует, пишет warn и остаётся на лёгком
idle-таймере, чтобы pm2 не попал в бесконечный цикл рестартов во время dark launch.

При `NOTIFY_EMBEDDED=true` те же два цикла поднимаются из `server.ts` рядом с
`startFxQueue()`; отдельный процесс в этом случае не запускается. Оба режима
одновременно включать нельзя — при `NOTIFY_EMBEDDED=true` `worker.ts` логирует
ошибку и завершается.

Запуск в проде:

```bash
pm2 start ecosystem.config.cjs
```

В `ecosystem.config.cjs` описаны API и ровно один экземпляр `pulim-worker`.

### 5.2. Планировщик, раз в 15 минут

**Проход А — ежедневные сообщения.**

```
profiles.where('notifications.nextDailyAt', '>', 0)
        .where('notifications.nextDailyAt', '<=', now)
        .limit(NOTIFY_PLANNER_BATCH)
```

Если выборка вернула полный батч — сразу следующая итерация (до 10 за тик), чтобы
очередь не отставала. Каждый пользователь обрабатывается в своём `try/catch`:
один сбойный профиль не должен ронять проход.

Для каждого профиля:

```
a) СНАЧАЛА сдвинуть nextDailyAt на завтра 10:00      ← до сбора данных, чтобы падение
                                                       сборщика не крутило одного и
                                                       того же пользователя вечно
b) если !enabled или telegram.status ∈ (blocked, unreachable) → дальше не идём
c) если исходный nextDailyAt устарел больше чем на 6 часов → пропустить `stale_slot`
d) прочитать notificationState/{uid}
e) собрать блоки (collectors/daily.ts, раздел 6.1):
     события дня · недельный отчёт (пн) · месячный отчёт (1-е) · жизненный цикл
   каждый блок сам проверяет свои ключи в state и молчит, если повод уже отработан
f) блоков нет → задание не создаётся                 ← «нечего сказать — не пишем»
g) create() задания type='daily' с dedupeKey, runAt = исходный nextDailyAt и
   списком stateKeys. Так поздний рестарт не превращает старый утренний слот в свежий
```

**Проход Б — служебные задачи.**

```
notificationTasks.where('status', '==', 'pending').where('runAt', '<=', now).limit(50)
```

Для `budget_check`: посчитать бюджеты (раздел 6.5), при пересечении порога создать
задание `budget_80` / `budget_100`, затем пометить задачу `done`.

### 5.3. Доставка, раз в 5 секунд

```
notifications.where('status', '==', 'pending')
             .where('nextAttemptAt', '<=', now)
             .orderBy('nextAttemptAt')
             .limit(NOTIFY_DELIVERY_BATCH)
```

Для каждого задания:

```
1. now > staleAt → skipped('stale'). При создании staleAt = runAt + 6 ч;
   перенос из тихих часов обновляет staleAt = deferredUntil + 6 ч, поэтому событие
   в 23:30 доживает до 08:00 и после этого имеет полное окно актуальности.
2. ЗАХВАТ. db.runTransaction: если status !== 'pending' или leaseUntil > now → пропустить;
   иначе status = 'sending', attempts++, leaseUntil = now + NOTIFY_LEASE_MS.
   Без захвата два инстанса или наложение тиков отправят одно и то же дважды.
3. перечитать профиль:
     !enabled или telegram.status ∈ (blocked, unreachable) → skipped('disabled')
4. isQuietHour(now) → status = 'pending', deferredUntil = shiftOutOfQuietHours(now),
     nextAttemptAt = deferredUntil, staleAt = deferredUntil + 6 ч,
     leaseUntil = null; продолжить
5. аварийный потолок: sentDay === сегодня и sentCount >= NOTIFY_SAFETY_MAX_PER_USER_PER_DAY
     → skipped('safety_cap') с logger.error: это всегда признак бага, а не нормы
6. отрендерить текст и клавиатуру по payload и АКТУАЛЬНОМУ profile.language
     (язык берём при отправке, а не при постановке в очередь)
7. если introSentAt пуст — добавить пояснительный хвост (раздел 6.7)
8. sendMessage → в одной транзакции:
     задание: status = 'sent', messageId, sentAt, leaseUntil = null
     профиль: sentCount++, sentDay, lastSentAt, telegram.status = 'reachable',
              introSentAt при первой отправке
     notificationState: дописать stateKeys
9. записать telegramMessages/{chatId}_{messageId} с kind='notification' — иначе кнопки
   не заработают
```

**Возврат аренды.** Отдельный recovery-запрос по индексу `status + leaseUntil`
переводит уведомление в статусе `sending` с истёкшей арендой в
`failed('lease_lost')`, а **не** возвращает в `pending`. Для напоминания потерянное
сообщение безопаснее дубля; повод останется неотмеченным в `notificationState` и
всплывёт при следующем ежедневном проходе, если ещё актуален. Зависшая бюджетная
задача, напротив, безопасно возвращается в `pending`: она сама ничего не отправляет,
а итоговые уведомления защищены `dedupeKey`.

**Троттлинг:** не более `NOTIFY_SEND_RATE_PER_SEC` отправок в секунду суммарно и не
чаще одной в секунду в один чат (в рамках прохода группировать по `chatId`).

**Обработка ошибок Bot API** (требует `TelegramApiError` из 2.2):

| Ответ | Действие |
|---|---|
| `429` + `parameters.retry_after` | `nextAttemptAt = now + retry_after*1000 + jitter(0..1000)`, `status = 'pending'`, `attempts` **не** увеличивать |
| `403 bot was blocked by the user` | `telegram.status = 'blocked'`; текущее и все `pending` задания пользователя → `cancelled` |
| `403 bot can't initiate conversation` | `telegram.status = 'unreachable'`; то же |
| `400 chat not found` / `user is deactivated` | `telegram.status = 'unreachable'`, `cancelled` |
| `5xx`, сеть, таймаут | `status = 'pending'`, `nextAttemptAt = now + min(3600s, 2s * 2^attempts)`; при `attempts >= NOTIFY_MAX_ATTEMPTS` → `failed` |

**Возврат в строй.** Когда пользователь пишет боту `/start` или любое сообщение,
сбрасывать `telegram.status = 'reachable'`, `lastError = null` и обновлять `chatId`.

### 5.4. Бюджетные проверки — по событию

`scheduleBudgetCheck(uid)` вызывается после успешного создания, изменения или удаления
транзакции:

```
transaction(notificationTasks/sha256('budget_check:' + uid)):
  version++
  если status = processing → rerunAt = now + debounce
  иначе status = pending, runAt = now + debounce
```

Это настоящий trailing debounce: серия изменений всё время сдвигает проверку, а
версионирование не даёт обработчику потерять изменение, пришедшее во время расчёта.

Вызов из HTTP-пути — строго fire-and-forget: ошибка не должна ломать ответ на создание
транзакции.

Денежные операции, идущие мимо `createTransaction` (оплата подписки, погашение долга,
операции по депозитам), бюджетную проверку не вызывают: они пишутся с `source`, а
бюджеты по категориям считают только обычные расходы.

---

## 6. Контент

Общие правила рендера: `parse_mode: 'HTML'`, экранирование через существующий
`escapeHtml` из `src/telegram/render.ts` во всех пользовательских строках, суммы с
неразрывными пробелами, названия дефолтных категорий — через
`src/telegram/categoryAliases.ts:categoryDisplayName` на языке пользователя.
Максимум ~3500 символов на сообщение.

Форматирование денег и дат выносится в `src/notifications/format.ts` и покрывается
тестами: сейчас в боте суммы печатаются сырым `${amount} ${currency}`.

**Кнопки `[📊 Графики]` не существует.** Вкладки `charts` и `calendar` скрыты из
навигации (`pulim-ui-v2/src/components/BottomNav.tsx:38`), вести туда нельзя.

### 6.1. Ежедневное сообщение (`daily`)

Собирается на локальный день и склеивается из блоков в фиксированном порядке.
**Нет ни одного блока → задание не создаётся.**

```
1. 🔔 Жизненный цикл  (не более одного повода за раз, раздел 6.6)
2. 📅 События дня      (раздел 6.2)
3. 📊 Отчёт           (недельный по понедельникам, месячный 1-го; раздел 6.3–6.4)
```

Порядок именно такой: если триал заканчивается завтра, это важнее списания подписки.
Если в сообщении есть и отчёт, и события дня — сначала короткое «что сегодня», потом
цифры за период.

Ограничения: суммарно не более 8 строк-пунктов, дальше «… и ещё N» и кнопка
«📱 Открыть Pulim»; не более 6 кнопок действия.

### 6.2. Блок «События дня»

| Секция | Условие | Ключ в `notificationState` |
|---|---|---|
| 💳 Подписки | `isActive` и `nextBillingDate` попадает в сегодня или завтра | `sub:{id}:{YYYY-MM-DD nextBillingDate}` |
| 💰 Долги | `!isPaid` и `dueDate` через 3 дня / сегодня / просрочен | `debt:{id}:3d`, `debt:{id}:due`, `debt:{id}:overdue:{YYYY}-W{ww}` |
| 🏦 Кредитка | `cardType === 'credit'`, `dueDay` сегодня или через 2 дня, `balance > 0` | `card:{id}:{YYYY-MM}` |
| 🏛 Депозиты | `endDate` через 7 или 1 день; либо `showInterest` и `calcRemainingInterest > 0` | `deposit:{id}:7d`, `deposit:{id}:1d`, `deposit:{id}:interest:{YYYY-MM}` |
| 🎯 Цели | `deadline` через 7 дней и `savedAmount < targetAmount` | `goal:{id}:7d` |

**Ключи привязаны к сущности и горизонту, а не к дню.** Иначе долг с датой возврата
5-го числа попал бы в сообщение 2-го, 5-го и дальше каждый день, пока просрочен, —
а именно это гарантированно приводит к блокировке бота. Просроченный долг
напоминает о себе не чаще раза в неделю.

```
☀️ Доброе утро! Сегодня 2 сентября

💳 Списываются подписки
· Netflix — 120 000 сум
· Spotify — 60 000 сум

💰 Долг
· Вернуть Азизу 500 000 сум — сегодня

[💳 Оплатить Netflix] [💳 Оплатить Spotify]
[💰 Погасить долг]
[📱 Открыть Pulim] [🔕 Отключить]
```

Бесплатному пользователю блоки по долгам, депозитам и целям показываются как есть,
а в конце сообщения добавляется одна строка:
«💎 Управлять долгами и накоплениями можно в Premium» и кнопка `[💎 Premium]`.
Данные не скрываем: они принадлежат пользователю и напоминание о них — услуга,
а не наживка.

### 6.3. Недельный блок (по понедельникам)

Период — прошлая неделя, пн–вс, локально. Суммы — только UZS-эквивалент (`amount`
для UZS, `baseAmount` для остальных; транзакции без `baseAmount` не суммируются, но
их количество показывается строкой «N операций без курса»). Возвраты
(`source === 'return'`) вычитаются из расходов, переводы исключены — правило один в
один как в `pulim-ui-v2/src/pages/Transactions.tsx:329` (`summaryTotals`).

```
📊 Неделя 25 — 31 августа

Расходы: 1 240 000 сум (−12% к прошлой неделе)
Доходы: 0
Записано операций: 23

Топ категорий:
1. 🍔 Еда — 520 000
2. 🚗 Транспорт — 310 000
3. 🛍 Покупки — 210 000

💡 Развлечения выросли в 2,8 раза — почти всё в выходные.   ← Premium, одна строка от AI

[📱 Открыть Pulim] [🔕 Отключить]
```

Если за неделю не было ни одной операции — вместо цифр одна строка:
«За неделю ни одной записи. Записать трату можно прямо здесь: `обед 45к`».
**Такая строка отправляется не более двух недель подряд**, дальше недельный блок
молчит до появления активности: писать тому, кто уже отвалился, — прямой путь к
блокировке. Счётчик хранится в `notificationState.weeklyEmptyStreak` и сбрасывается
после успешно отправленного отчёта с активностью.

### 6.4. Месячный блок (1-го числа)

```
📈 Итоги августа

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

[📱 Открыть Pulim] [🔕 Отключить]
```

Блок «💡 Разбор» — **только Premium** (`getIsPremium`). Реализация в
`src/notifications/ai.ts`: компактный промпт по образцу `buildForecastPrompt`,
strict JSON Schema `{ insight: string, tip: string }`, модель `NOTIFY_AI_MODEL`,
`store: false`, `recordAiUsage({ feature: 'monthly_report' })`.

`recordAiUsage` — только метрика, квоту пользователя она не тратит (квоту списывает
`consumeAiMessage`, `src/services/ai.service.ts:161`). Серверная инициатива не должна
съедать лимит человека — `consumeAiMessage` здесь **не вызывать**.

Сбой или таймаут AI не отменяет отчёт — блок просто не выводится, ошибка в логах.

Бесплатному пользователю вместо блока — строка
«💡 Персональный разбор месяца доступен в Premium» и кнопка `[💎 Premium]`.

### 6.5. Бюджеты (`budget_80`, `budget_100`)

Расчёт потраченного по категории повторяет `pulim-ui-v2/src/pages/Home.tsx:141`:
транзакции текущего месяца, `currency === 'UZS'`, `source !== 'transfer'`, возвраты
вычитаются.

> Расхождение известно: бюджеты на главной считаются только по UZS и игнорируют
> `baseAmount`, тогда как сводка в истории использует `baseAmount`. Уведомление
> обязано совпадать с тем, что человек видит на главной, поэтому копируем логику
> Home как есть. Приведение к общему знаменателю — отдельная задача вне этого ТЗ.

```
⚠️ Бюджет на исходе

🍔 Еда: 1 200 000 из 1 500 000 (80%)
Осталось 300 000 сум на 12 дней — это 25 000 в день.

💡 Больше всего ушло на доставку — 640 000 из 1 200 000.   ← Premium, без AI, агрегация

[📱 Открыть Pulim] [🔕 Отключить]
```

```
🔴 Бюджет превышен

🍔 Еда: 1 740 000 из 1 500 000 (+240 000)

[📱 Открыть Pulim] [🔕 Отключить]
```

Каждый порог — не чаще одного раза на категорию в календарный месяц (дедуп-ключ).
Premium-строка «куда ушло» строится агрегацией по подкатегориям и комментариям,
без обращения к модели.

### 6.6. Жизненный цикл

Триал теперь семидневный, выдаётся один раз в жизни и **только по явному действию**
(`POST /v1/profile/trial/start` → `services/profile.service.ts:startTrial`,
правила в `domain/trial.ts:getTrialBlockCode`). Поэтому набор поводов другой, чем в
версии 1.0. За один день отправляется **не более одного** повода, в порядке
приоритета сверху вниз.

| Ключ | Условие | Суть | Ключ состояния |
|---|---|---|---|
| `trial_ending_1d` | `isTrial`, `premiumUntil` завтра | Что отключится завтра + `[💎 Оформить Premium]` | `trial_1d:{uid}:{premiumUntil YYYY-MM-DD}` |
| `trial_ending_3d` | `isTrial`, `premiumUntil` через 3 дня (4-й день из 7) | То же, мягче | `trial_3d:{uid}:{premiumUntil YYYY-MM-DD}` |
| `premium_expired` | `premiumUntil` прошёл в последние 48 ч | Что отключилось, данные сохранены + `[💎 Продлить]` | `premium_expired:{uid}:{YYYY-MM-DD}` |
| `trial_available` | `getTrialBlockCode(profile) === null` и с `createdAt` прошло ≥ `NOTIFY_TRIAL_AVAILABLE_DAYS` | 7 дней Premium бесплатно, что откроется + `[💎 Попробовать 7 дней]` | `trial_available:1`, затем `trial_available:2` не раньше чем через `NOTIFY_TRIAL_AVAILABLE_REPEAT_DAYS` |
| `no_cards` | с `createdAt` прошло ≥ `NOTIFY_NO_CARDS_DAYS` и у пользователя нет ни одной карты | Один раз. Что настроить за минуту + `[📱 Открыть Pulim]` | `no_cards:{uid}` |

`trial_available` отправляется максимум дважды за всё время: на 3-й день после
регистрации и ещё раз через 21 день, если триал так и не начат. Подсчёт карт
(`no_cards`) влияет на сообщение только для профилей возрастом от 2 до 7 дней.

Пример `trial_ending_3d`:

```
💎 Пробный период заканчивается через 3 дня

После 5 сентября станут недоступны: бюджеты, долги, депозиты,
накопления, кредитные и наличные счета, расширенные графики.
Все данные останутся на месте.

[💎 Оформить Premium] [📱 Открыть Pulim]
```

### 6.6.1. Сообщение о старте триала (`trial_started`)

Отдельный тип, **не** ежедневный: ставится в очередь прямо из `startTrial()`
(`void queueTrialStarted(uid)`, ошибку глотать) и уходит в течение нескольких секунд,
если сейчас не тихие часы. Семь дней сгорают незаметно, если про них не сказать
в момент старта.

```
🎉 Premium включён на 7 дней — до 9 сентября

Что стало доступно:
📊 бюджеты по категориям
🤝 долги и погашения
🏛 депозиты и 🎯 накопления
💳 кредитные и наличные счета
📈 расширенные графики и фильтры

Начните с бюджета на еду — это занимает минуту.

[📱 Открыть Pulim] [🔕 Отключить]
```

### 6.7. Пояснительный хвост первого сообщения

К самому первому уведомлению в жизни пользователя добавляется:

```
—
Это напоминания Pulim. Отключить: /stop
```

Далее фиксируется `introSentAt`. Кнопка `[🔕 Отключить]` присутствует на всех
проактивных сообщениях постоянно, а не только на первом: сделать отключение проще, чем
блокировку, — самая дешёвая защита бота, которая у нас есть.

---

## 7. Действия из уведомления

Переиспользуется протокол `callback_data` и коллекция `telegramMessages` из первого
ТЗ: индексы вместо идентификаторов, проверка владельца, обязательный
`answerCallbackQuery`. Существующий шаблон
`/^v1:([a-z]+):(\d+)(?::([a-z0-9]+))?$/` (`callback.handler.ts:18`) менять не нужно —
все новые действия в него укладываются.

| Шаг 1 | Шаг 2 | Итог |
|---|---|---|
| `v1:paysub:<i>` | Экран: название, сумма, кнопки карт → `v1:psok:<i>:<k>` | `payTelegramSubscriptionOnce` |
| `v1:paydebt:<i>` | Экран: остаток долга, кнопки карт → `v1:pdok:<i>:<k>` | `payTelegramDebtOnce` |
| `v1:notifyoff:0` | — | `notifications.enabled = false`, все `pending` → `cancelled`, ответ с кнопкой «Включить обратно» |

Правила:

1. **Никогда не списывать по одному нажатию.** Первый тап только показывает экран
   подтверждения с полной суммой и выбором счёта.
2. Карты предлагаются алгоритмом `resolveCard` (`src/telegram/resolve/card.ts`):
   фильтр по валюте, порядок по давности использования, пометка «не хватает средств».
3. Все деньги — только через идемпотентные сервисы. Прямых записей нет.
4. **Погашение долга из чата закрывает весь остаток.** Частичная сумма — в приложении:
   отдельный шаг ввода суммы удваивает число экранов ради редкого случая.
   Точная сумма всегда показана на экране подтверждения до нажатия.
5. Повторное нажатие после выполнения обрабатывается маркером операции: сервис
   вернёт `created: false`, ответ `answerCallbackQuery` — «Уже оплачено», сообщение
   перерисовывается. `payTelegramDebtOnce` бросает `Error` на уже погашенном долге —
   это тоже надо поймать и показать «Уже погашено».
6. После выполнения исходное сообщение редактируется: строка получает ✅ и сумму,
   кнопка действия исчезает.

Ключи операций (устойчивы даже между разными сообщениями):

```
подписка: notify:sub:{subscriptionId}:{YYYY-MM-DD nextBillingDate}
долг:     notify:debt:{debtId}:{messageId}
```

### 7.1. Команды бота

- `/stop` — `notifications.enabled = false`, все `pending` → `cancelled`, ответ с
  кнопкой «Включить обратно».
- `/start notify` (диплинк из Mini App) — включить уведомления, ответить
  подтверждением, выставить `telegram.status = 'reachable'`.
  **Требует правки `dispatcher.ts:51`:** сейчас аргумент команды отбрасывается.

Команды `/settings` в боте нет: единственный переключатель живёт в приложении, а
выключить можно кнопкой под любым сообщением или `/stop`.

### 7.2. `payTelegramSubscriptionOnce`

Единственная денежная операция, у которой ещё нет идемпотентного варианта.
Пишется в `src/services/subscription.service.ts` по образцу `payTelegramDebtOnce`
(`src/services/debt.service.ts:181`):

```ts
export async function payTelegramSubscriptionOnce(
  uid: string,
  input: { subscriptionId: string; accountId?: string; expectedNextBillingDate: number },
  operationKey: string,
): Promise<{ subscriptionId: string; name: string; amount: number; currency: string;
             nextBillingDate: number; transactionId?: string; created: boolean }>;
```

- маркер `telegramOperationMarkerRef(uid, 'subscription_payment:' + operationKey)`;
- документ транзакции `telegramTransactionRef('subscription_payment:' + uid + ':' + operationKey, 'telegram_sub_payment_')`;
- внутри транзакции сверить `sub.data.nextBillingDate === input.expectedNextBillingDate`;
  не совпало — значит подписку уже оплатили, вернуть `created: false`;
- поля документа транзакции — как в существующем `paySubscription`
  (`type: 'expense'`, `categoryId: '__subscription__'`, `source: 'subscription'`,
  `sourceLabel: '<icon> <name>'`), плюс `origin: 'telegram'`;
- баланс карты — через `balanceDelta`, `nextBillingDate` — через `advanceBillingDate`.

Существующий `paySubscription` остаётся нетронутым: им пользуется HTTP-эндпоинт
`POST /v1/subscriptions/:id/pay`.

---

## 8. Изменения в `pulim-ui-v2`

### 8.1. Тумблер в настройках

Строка в блоке «Быстрые настройки» на главном экране настроек (`Settings.tsx`,
`renderHome`), рядом с уже существующим переключателем записи через Telegram —
отдельного подраздела не заводим:

- переключатель «Напоминания в Telegram»;
- подпись состояния доставки:
  - `reachable` → «Приходят в Telegram каждое утро, если есть о чём напомнить»;
  - `blocked` → «Вы заблокировали бота. Разблокируйте, чтобы получать напоминания»;
  - `unreachable` / `unknown` → ссылка «Включить в Telegram» на
    `https://t.me/{VITE_TELEGRAM_BOT_USERNAME}?start=notify`;
- запись через `PATCH /v1/profile/notifications`, оптимистично, с откатом при ошибке.

### 8.2. Баннер включения

Показывать на Home один раз по образцу `TelegramLinkBanner.tsx`, если
`notifications.enabled === true`, но `telegram.status !== 'reachable'`. Кнопка ведёт
на тот же диплинк. Закрытие запоминается в профиле
(`notificationsPromptDismissed: boolean`, добавить в `profilePatchSchema`).

### 8.3. Прочее

- `src/types.ts` — `NotificationSettings` (зеркало серверного) и `createdAt` в `UserProfile`.
- Хук `useNotificationSettings` поверх `api.patch('/v1/profile/notifications')` с
  инвалидацией `qk.profile(uid)`.
- i18n: новые ключи **во все три файла** (`settings.notifications_*`,
  `home.notify_banner_*`), иначе `npm run check:i18n` упадёт.
- `VITE_TELEGRAM_BOT_USERNAME` в `.env.example` — уже добавлен.

---

## 9. Наблюдаемость и защита

Логи (pino, существующий `utils/logger.ts`):

| Событие | Поля |
|---|---|
| `notify.planner.tick` | scanned, queued, skipped, durationMs |
| `notify.queued` | uid, type, dedupeKey, blocks |
| `notify.sent` | uid, type, messageId, latencyMs |
| `notify.skipped` | uid, type, skipReason |
| `notify.failed` | uid, type, attempts, err |
| `notify.blocked` | uid, reason (`blocked` / `unreachable`) |
| `notify.action` | uid, action, result |

Правила:

1. В логах — никаких сумм, названий категорий, имён людей и текстов сообщений;
   только идентификаторы и счётчики.
2. Аварийный потолок `NOTIFY_SAFETY_MAX_PER_USER_PER_DAY` — жёсткий, срабатывание
   логируется как `error`: при штатной работе одно плановое сообщение в сутки плюс
   редкое бюджетное, до потолка дойти нельзя.
3. Тихие часы 22:00–08:00 действуют на **все** типы без исключений.
4. Доля `403` выше 5% отправок за час → `logger.error` с отдельным маркером. Счётчики
   писать в `notificationStats/{YYYY-MM-DD-HH}` через `FieldValue.increment`.
5. Планировщик не падает целиком из-за одного профиля.

---

## 10. Тесты

Юнит (`vitest`) — только чистые функции:

- `schedule.test.ts` — слот 10:00 в Asia/Tashkent, переход через полночь, тихие часы
  на границах 21:59 / 22:00 / 07:59 / 08:00, `shiftOutOfQuietHours`.
- `events.test.ts` — сборка секций: пустой день даёт пустой список; подписка завтра
  попадает, послезавтра нет; просроченный долг попадает; депозит за 7 и за 1 день.
- `dedupe.test.ts` — ключи на сущность и горизонт: долг с датой через 3 дня даёт один
  ключ, на следующий день — не даёт; просроченный долг даёт один ключ в неделю;
  ключи не сгорают, если сообщение не отправлено.
- `weekly.test.ts` — агрегация: переводы исключены, возвраты вычтены, не-UZS без
  `baseAmount` не суммируются, деление на ноль при нулевой прошлой неделе,
  молчание после двух пустых недель подряд.
- `monthly.test.ts` — топ категорий и проценты, состояние бюджетов, сумма подписок.
- `lifecycle.test.ts` — приоритет поводов (одновременно `trial_ending_1d` и
  `trial_available` → только первый); `trial_available` не чаще двух раз;
  `premium_expired` в окне 48 часов; `no_cards` только в окне 2–7 дней.
- `budget.test.ts` — 79,9% не триггерит, 80,0% триггерит, 100% триггерит отдельно,
  повторный вызов в том же месяце не создаёт дубль.
- `backoff.test.ts` — задержки, потолок в час, переход в `failed` на 8-й попытке,
  `429` не увеличивает `attempts`.
- `format.test.ts` — разряды и неразрывные пробелы, склонения дней, экранирование HTML.

---

## 11. Критерии приёмки

| # | Сценарий | Ожидаемо |
|---|---|---|
| 1 | Подписка списывается завтра, долг возвращать сегодня | В 10:00 **одно** сообщение с двумя секциями и кнопками |
| 2 | На сегодня нет ни одного повода | Сообщение **не отправлено**, задание не создано |
| 3 | Понедельник 1-го числа, есть события дня | **Одно** сообщение: события + месячный отчёт (недельный в этот день уступает месячному) |
| 4 | Тап «Оплатить Netflix» → выбор карты → «Подтвердить» | Одна транзакция `source: 'subscription'`, баланс карты уменьшен, `nextBillingDate` сдвинут, строка получила ✅ |
| 5 | Повторный тап «Подтвердить» | «Уже оплачено», второй транзакции нет, `nextBillingDate` не сдвинут повторно |
| 6 | Тап «Погасить долг» → карта → «Подтвердить» | `payTelegramDebtOnce` на весь остаток, долг `isPaid`, повторный тап отвечает «Уже погашено» |
| 7 | Планировщик отработал дважды за один день | Ровно одно задание `daily` (проверить по `dedupeKey`) |
| 8 | Два воркера одновременно взяли одно задание | Отправка ровно одна: второй захват не проходит по `leaseUntil` |
| 9 | Долг с датой возврата через 3 дня | Напоминание один раз, назавтра повтора нет; в день возврата — снова один раз |
| 10 | Долг просрочен две недели | Не более одного напоминания в неделю |
| 11 | Пользователь заблокировал бота | Первая же отправка → `telegram.status = 'blocked'`, все `pending` → `cancelled`, попыток больше нет |
| 12 | Пользователь разблокировал и написал `/start` | Статус `reachable`, со следующего дня напоминания идут |
| 13 | Пользователь никогда не нажимал Start | `unreachable`, в Mini App показан баннер «Включить в Telegram» |
| 14 | Трата, доводящая категорию до 80% бюджета | Через ~5 минут уведомление; следующая трата в том же месяце нового не порождает |
| 15 | Превышение того же бюджета | Отдельное уведомление `budget_100` |
| 16 | Бюджетная задача в очереди | Задача лежит в `notificationTasks` и физически не может быть отправлена доставкой |
| 17 | Понедельник, Premium | Недельный отчёт с корректными суммами и AI-строкой; переводы не попали в расходы; возвраты вычтены |
| 18 | 1-е число, Premium | Месячный отчёт с блоком «💡 Разбор»; квота AI-сообщений пользователя **не** уменьшилась |
| 19 | 1-е число, free | Тот же отчёт без AI-блока, со строкой апселла и кнопкой Premium |
| 20 | OpenAI недоступен 1-го числа | Отчёт отправлен без блока разбора, ошибка в логах |
| 21 | Три недели подряд без единой операции | Строка «ни одной записи» пришла дважды, на третью неделю недельный блок промолчал |
| 22 | Пользователь нажал «Начать пробный период» | В течение минуты приходит `trial_started` со списком открывшегося |
| 23 | 4-й день семидневного триала | `trial_ending_3d`; повторно в тот же день не приходит |
| 24 | 6-й день триала | `trial_ending_1d`; `trial_ending_3d` повторно не приходит |
| 25 | Зарегистрировался 3 дня назад, триал не начинал | `trial_available`; следующий раз не раньше чем через 21 день, и только дважды за всё время |
| 26 | Триал закончился вчера | `premium_expired` один раз |
| 27 | Одновременно «триал кончается завтра» и события дня | Одно сообщение, блок жизненного цикла первым |
| 28 | Задание пролежало 7 часов из-за сбоя | `skipped('stale')`, устаревшие цифры не отправлены |
| 29 | Бюджетное событие в 23:30 | Отправлено в 08:00 следующего дня, **не** отброшено как `stale` |
| 30 | Выключить тумблер в настройках | Ничего не приходит; `pending`-задания отменены; профиль больше не попадает в ежедневную выборку |
| 31 | Нажать «🔕 Отключить» под сообщением | То же, плюс ответ с кнопкой «Включить обратно» |
| 32 | Старый профиль без `notifications` | После `bootstrap()` или скрипта миграции появляются `createdAt` и дефолты, профиль попадает в рассылку |
| 33 | Воркер убит на середине прохода | После рестарта задания доотправляются, дублей нет; задание в `sending` с истёкшей арендой уходит в `failed`, а не отправляется повторно |
| 34 | `NOTIFICATIONS_ENABLED=false` | Воркер стартует, ничего не шлёт, API работает как прежде |

Технические:

- HTTP-путь создания транзакции не замедлился: `scheduleBudgetCheck` асинхронный и его
  сбой не влияет на ответ.
- Быстрая запись через Telegram не сломана: существующие тесты `tests/telegram/*`
  проходят, глобальных Premium-гейтов в `callback.handler.ts` не добавлено.
- Никакие расчёты Mini App не изменились — уведомления только читают данные,
  а действия из чата идут через идемпотентные сервисы.

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

---

## 12. Что НЕ входит в v1

- Web Push, e-mail, SMS (включая уже подключённый Eskiz).
- Вечерний итог дня.
- Выбор времени и выбор типов уведомлений пользователем.
- Персональный часовой пояс: всё считается в `Asia/Tashkent`.
- Напоминания по `planned_expenses`, зарплатным дням и дням рождения — экран
  «Календарь» скрыт, а поля онбординга у большинства пусты.
- «Вы давно не записывали трат» и прочие поведенческие нудж-и, кроме одной строки в
  недельном отчёте при нулевой активности.
- Обнаружение необычных трат, антифрод-подобные алерты.
- A/B-тесты формулировок, сегментация, маркетинговые рассылки «всем».
- Приведение бюджетов к общей валютной логике (`baseAmount` вместо `currency === 'UZS'`) —
  отдельная задача, меняет цифры на главном экране.

---

## 13. Порядок работ

Коммиты по этапам; каждый этап собирается и проходит проверки.

1. **Подготовка.** `TelegramApiError` в `src/telegram/client.ts`, аргумент команды в
   `dispatcher.ts`, `profile.createdAt`, конфиги композитных индексов в репозитории
   и TTL в консоли.
   *Проверка:* существующие тесты Telegram проходят, быстрая запись работает.
2. **Каркас воркера.** `worker.ts`, два пустых цикла, graceful shutdown, env, скрипты,
   `NOTIFICATIONS_ENABLED`, `NOTIFY_EMBEDDED`.
   *Проверка:* процесс поднимается и логирует тики; сценарий 34.
3. **Модель настроек.** `profile.notifications`, дефолты в `bootstrap()`,
   `PATCH /v1/profile/notifications`, скрипт бэкфилла.
   *Проверка:* сценарий 32.
4. **Очередь и доставка.** `notifications`, `notificationState`, захват с арендой,
   бэкофф, обработка 403/429, тихие часы, аварийный потолок.
   *Проверка:* сценарии 8, 11, 12, 28, 29, 33.
5. **Жизненный цикл.** `trial_started` из `startTrial()`, `trial_available`,
   `trial_ending_3d`, `trial_ending_1d`, `premium_expired`, `no_cards`.
   *Проверка:* сценарии 22–26.
6. **События дня.** `collectors/events.ts`, дедуп на сущность и горизонт, рендер,
   `format.ts`, `notifications/i18n.ts`.
   *Проверка:* сценарии 1, 2, 7, 9, 10, 27.
7. **Действия из чата.** `payTelegramSubscriptionOnce`, `actions.handler.ts`,
   расширение `telegramMessages`, кнопка «🔕 Отключить».
   *Проверка:* сценарии 4, 5, 6, 31.
8. **Бюджеты.** `scheduleBudgetCheck`, `notificationTasks`, пороги, Premium-разбор.
   *Проверка:* сценарии 14, 15, 16.
9. **Отчёты.** Недельный, затем месячный, затем AI-блоки для Premium.
   *Проверка:* сценарии 3, 17–21.
10. **UI.** Тумблер, баннер, хук, i18n во все три файла.
    *Проверка:* сценарии 13, 30.
11. **Приёмка** по таблице раздела 11, обновление `README.md` обоих репозиториев и
    `PROJECT_CONTEXT.md`, деплой индексов и включение TTL-политик сначала в тестовом
    Firebase. Глобальный `NOTIFICATIONS_ENABLED` включается только после этого и
    успешной проверки тестового Telegram-бота.
