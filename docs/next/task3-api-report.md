# Task 3 — Part A (API): отчёт

Дата: 2026-11-04. Worktree: `/Users/macbookair/WebstormProjects/pulim-api-v2/.claude/worktrees/push`, ветка `claude/push`.

Прочитан весь `task3-push.md`, общий контракт, раздел 3 утверждённого плана из `claude/apple-subscriptions`, AGENTS.md и docs/ai. Изменений в app-репозитории нет. Push по умолчанию выключен. Push/deploy/merge, EAS и миграции на реальных БД не выполнялись. `.env*`, реальные ключи и `.p8` не читались; в `.env.example` только дописаны пустые placeholders и выключенный флаг. Для проверок загрузка dotenv перенаправлена в `/dev/null`.

## Коммиты

Все коммиты имеют завершающий `Co-Authored-By: Codex <noreply@openai.com>` после пустой строки.

| Коммит | Изменение |
|---|---|
| `237feb6` | APNs sender: JWT, HTTP/2, reconnect, классификация ответов; injected transport tests |
| `b365efb` | 21 шаблон uz/ru/en, APNs payload, чистый планировщик и send-time revalidation |
| `19dc820` | Устройства, миграция, настройки, профиль, capability, HTTP/schema/storage tests |
| `cc15fc3` | Срок повторной попытки при provider auth circuit |
| `8d95bc7` | Тесты маршрутизации и частичной доставки |
| `d69f359` | Проверка хешированных collapse ids |
| `d7fff9c` | Тесты auth pause, terminal token fallback и запрета anonymous guest |
| `582134d` | Тесты переходов событий и транзакционного outbox/debounce |
| `ff7b688` | Интеграция очереди, каналов, транзакционных событий, расписания и лимитов |
| `3abe6ed` | Тесты post-commit перепланирования и исключения внутренних counters |
| `90a42dd` | Перепланирование пользователя после регистрации и commit изменений |

Документация и этот отчёт завершаются отдельным коммитом `Document native push contract and API verification report`; его hash доступен в истории ветки.

## Что реализовано

- `POST /v1/push/devices` возвращает ровно `{device:{id,environment,enabled}}`. Hex token нормализуется; unique-token upsert переносит владельца, сбрасывает disable-state, обновляет lastSeenAt. Язык/часовой пояс профиля записываются атомарно с устройством. Устаревший владелец не может удалить переданный токен. DELETE идемпотентен, 204. Anonymous Firebase users не допускаются.
- `GET /v1/profile` и PATCH уведомлений соответствуют общему контракту. `pushActive` вычисляется из включённых устройств. Старый PATCH `{enabled}` работает; частичные group/quietHours updates не сбрасывают соседние поля. GET/PATCH профиля всегда возвращают полный прежний объект notifications, включая telegram. Дефолты: money/family/premium/habit=true, familyExpenses=false, alsoTelegram=false, 22:00–08:00, Asia/Tashkent. Язык и timezone валидируются. Capability `pushNotifications` зависит от включённого push, готовности APNs и таблицы устройств.
- ES256 JWT кешируется 50 минут. HTTP/2 sessions переиспользуются отдельно для production/sandbox и пересоздаются после разрыва/GOAWAY. Есть topic, alert type, priority 10, expiration, hash collapse id для бюджета. Невалидные токены выключаются с reason; lastSeenAt защищает свежую перерегистрацию от запоздалого ответа. 429/5xx используют существующий backoff; 403/signing failure ставят provider circuit до refresh, без расходования попыток задания.
- Активное устройство и настроенный sender выбирают push, Telegram добавляется только при alsoTelegram. При отсутствующей конфигурации/миграции остаётся Telegram. После отказа всех токенов текущая доставка тоже может перейти в Telegram. Digest для Telegram-only сохранён. Push-события индивидуальные; при alsoTelegram старый digest покрывает плановые поводы, поэтому отдельный push-план не создаёт второй Telegram digest. Рассылки используют этот же выбор канала и маркетинговые предпочтения; существующие campaign counters с названиями `telegram*` учитывают выбранную внешнюю доставку, включая push.
- В `SqlTransaction.flush` события достижения цели, вступления в семью, семейного расхода и платного Premium сохраняются в notifications на том же SQL executor, что и исходная запись. Доставка вызывается только после commit и использует общую claim/lease с worker. Повторы транзакции не отправляют внешние запросы. События одной транзакции дедуплицируются в памяти и по постоянному id.
- Для владельцев включённых устройств бюджетные задачи записываются вместе с транзакцией по uid/category, с debounce 25 секунд; legacy-задача для такого uid не создаётся. Telegram-only сохраняет прежний debounce 300 секунд. Учитываются обе категории при переносе операции. API timer будит доставку после commit, а 5-секундный worker обрабатывает задачи независимо от 15-минутного планировщика. Месячные ключи порогов сохранены.
- Планировщик обходит enabled-device owners без требования Telegram chat. Планирует сегодня/завтра по локальному времени: 10:00 для сроков/итогов и 21:00 для вечернего напоминания. Проверяет текущие данные перед отправкой, отменяет неактуальные поводы, обновляет данные/язык, переносит ещё не начатые слоты после смены timezone на следующем проходе. Нет дублирования local planned-expense reminders. Вечерние напоминания ограничены первыми 14 локальными календарными днями и отсутствием личных записей за день. Итоги приоритетнее вечернего напоминания; monthly приоритетнее weekly при совпадении.
- Quiet hours с минутной точностью и timezone, включая DST. Только budget_100 и apple_billing_failed имеют time-sensitive. Шесть логических сообщений в локальный день максимум; habit — не чаще одного. Первый принятый канал атомарно учитывается в лимите. Успешные устройства/Telegram записываются отдельно и не отправляются заново при retry другого получателя.
- Все 21 шаблон uz/ru/en и три категории действий присутствуют. Русские тексты взяты из плана; текст ограничен 50/150 Unicode characters без разрыва emoji. Apple billing failure — только тип/шаблон, источника события нет по брифу.
- Per-send log `notify.push.latency`: event→enqueue, enqueue→send, APNs response, total; rolling p50/p95 последних 500 измерений по типу в процессе. Токены/тексты не логируются; DELETE URL с токеном редактируется в request logger.

## Миграция SQL

Добавлена `004_push_devices` в существующий additive migrator. Ниже эквивалент новой части; timestamps — epoch milliseconds. Сам migrator проверяет наличие secondary index до CREATE INDEX и записывает marker после DDL. Он также содержит предыдущие миграции репозитория: это не отдельный новый автоматический production шаг.

```sql
CREATE TABLE IF NOT EXISTS push_devices (
  id CHAR(64) NOT NULL PRIMARY KEY,
  uid VARBINARY(512) NOT NULL,
  token VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  platform VARCHAR(16) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  bundle_id VARCHAR(255) NOT NULL,
  app_version VARCHAR(64) NOT NULL,
  build_number VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  disabled_at BIGINT NULL,
  disabled_reason VARCHAR(255) NULL
);
-- Создавать только если отсутствует (как делает migrator).
CREATE INDEX push_owner_enabled ON push_devices (uid, disabled_at);
INSERT INTO schema_migrations (version, applied_at)
VALUES ('004_push_devices', CURRENT_TIMESTAMP)
ON DUPLICATE KEY UPDATE version = VALUES(version);
```

До применения миграции чтение enabled devices/pushActive безопасно возвращает отсутствие устройств, доставка остаётся Telegram. Регистрация требует установленную таблицу. Применение production миграции — отдельное решение владельца.

## Новые env names

| Имя | Дефолт / назначение |
|---|---|
| `PUSH_ENABLED` | `false`; дополнительный выключатель APNs |
| `APNS_KEY_ID` | пусто; Apple signing key id |
| `APNS_TEAM_ID` | пусто; Apple developer team id |
| `APNS_KEY_PATH` | пусто; путь к runtime signing key |
| `APNS_BUNDLE_ID` | `com.izik.pulim`; bundleId при регистрации обязан совпадать с настройкой |

Существующие `NOTIFICATIONS_ENABLED`, `NOTIFY_ALLOWED_UIDS`, background/maintenance gates сохранены. Дефолт `NOTIFY_BUDGET_DEBOUNCE_MS` восстановлен до 300000 для Telegram-only; отдельный per-category push путь использует 25000. Никакая реальная конфигурация не изменялась.

## Проверки

Установлены зависимости через `npm ci`. Финальный прогон:

```sh
DOTENV_CONFIG_PATH=/dev/null npm run typecheck
DOTENV_CONFIG_PATH=/dev/null WEB_APP_URL=https://example.test FIREBASE_PROJECT_ID=test-project TELEGRAM_BOT_TOKEN=000000:test npm test
DOTENV_CONFIG_PATH=/dev/null npm run build
```

Все три проверки зелёные после review fixes: **525 passed, 53 skipped; 63 test files passed, 3 skipped**. Skipped — opt-in MySQL integration suites, намеренно не запускались. Дополнительно ESLint изменённых модулей и push tests, а также whitespace diff check — зелёные.

Покрыты: контракт HTTP/валидация и guest rejection, upsert/move/unregister, default/partial preferences, missing migration fallback, APNs headers/cache/errors/reconnect через injected transport, маршрутизация/quiet hours/timezones/DST, месячная дедупликация порогов, debounce/leases, transaction outbox и rollback, две конкурентные claim, дневной cap/частичные ack, локализации всех типов, расписание и revalidation. APNs tests не обращаются в сеть; HTTP endpoint tests используют только локальный fake server.

## Не проверено и границы

- Не выполнялись реальные SQL миграции или end-to-end MySQL concurrency tests. Атомарность SQL кода проверена unit/mock tests и чтением существующего механизма транзакций; реальный DDL/locking требует отдельно разрешённой локальной rehearsal БД.
- Не использовались Apple credentials и реальные APNs sandbox/production. Реальная доставка, permission UI, cold-start tap, action buttons и взаимодействие с Part B требуют проверки владельцем/исполнителем приложения. Сервер использует plural links общего контракта (`/accounts/…`, `/debts/…`, `/subscriptions/…`, `/goals/…`); существующие app routes singular, их преобразует Part B.
- В модели нет суммы минимального платежа кредитки и ссылки счёта у пользовательской подписки. У кредитки используется текст без суммы, у подписки — локализованное общее обозначение счёта. Расчёт начисления процентов опирается на существующую модель капитализации; это уведомление о расчётном дне, не новая банковская проводка.
- Регистрация устройства и commit изменений сроков, языка или timezone запускают перепланирование пользователя без ожидания периодического сканирования. Заранее поставленные задания обслуживает 5-секундный цикл; периодический скан остаётся страховкой после перезапуска. При полном простое API/worker точное время доставки не гарантируется; действуют stale-window и bounded retries.
- Существующая консервативная политика неизвестного исхода lease сохранена: истёкшая sending lease становится failed, не переотправляется вслепую. Падение между reservation и первым ack может оставить резерв до локальной полуночи. После принятия APNs и до сохранения ack распределённую exactly-once гарантию дать нельзя. Cap считается по первому принятому каналу логического уведомления, а не повторно для второго устройства после полуночи.
- Production migration, установка ключа и включение PUSH_ENABLED/расширение allowlist остаются вне этой задачи и не выполнялись.

## Review fixes

Все 14 пунктов из `push-api-fixes.md` исправлены 2026-11-04. Общий HTTP/payload контракт сохранён. Основной принцип: для пользователей без включённого устройства сохранены прежние Telegram-события, тайминги, quiet hours и рассылки.

| № | Исправление и регрессионные тесты |
|---|---|
| 1 | `documents.ts` больше не импортирует app env; boot инжектирует switch в отдельный модуль без зависимостей. `tests/migration/import.test.ts` импортирует migrator в отдельном процессе только с MYSQL_* и пустым cwd, без выхода/подключения к БД. |
| 2 | GET/PATCH профиля объединяют notificationDefaults, сохранённые поля и push-настройки, включая nested telegram. `tests/push/profile.test.ts` проверяет superset старого ответа для обоих HTTP handlers и сохранение legacy overrides. |
| 3 | Immediate outbox проверяет включённое устройство у каждого получателя; новые goal_reached/family_joined/premium_activated не попадают Telegram-only пользователям. Покрыто `tests/push/outbox.test.ts`. |
| 4 | Time-sensitive обходит quiet hours только на APNs; Telegram копия/fallback откладывается, уже принятые push не повторяются. Legacy Telegram window сохранён. Покрыто delivery/routing tests. |
| 5 | Campaigns снова обходят reminder master switch и резервируют слот с allowReminderDisabled=true. Marketing consent применяется до подавления Telegram устройством; при inApp=false и telegram=true выбирается Telegram. Покрыто delivery/routing tests. |
| 6 | Чужой bundleId получает 400. BadTopic/TopicDisallowed/DeviceTokenNotForTopic отключают устройство с reason и разрешают Telegram fallback той же доставки, включая topic-403 без provider circuit. Покрыто routes/apns/delivery tests. |
| 7 | Notifications используют INSERT с no-op duplicate update без pre-read. Задача сначала вставляется тем же способом, затем читается/обновляется уже существующая строка; прежний debounce/lease сохранён. Non-lock ошибки hook логируются и поглощаются, deadlock/lock timeout передаются retry. Покрыто outbox/writeHook tests. |
| 8 | Capability требует PUSH_ENABLED, APNs с читаемым ключом (одна проверка при создании sender) и таблицу (кешированный first-use probe). Регистрация при выключенном push/нет таблицы возвращает 503 PUSH_UNAVAILABLE; unreadable key сохраняет Telegram routing. Покрыто availability/capabilities/routes/devices/apns tests. |
| 9 | Legacy debounce восстановлен до 300000ms, включая тест реальной env schema. Per-category путь 25000ms только с включённым устройством; legacy-задача для него не создаётся. Новые task docs имеют expiresAt на 90 дней. Покрыто budgetTiming/outbox tests. |
| 10 | HTTP/2 sessions unref'ed. API и worker закрывают APNs при shutdown; новые kicks прекращаются, текущие planning/delivery ожидаются максимум 5 секунд. Покрыто apns/kick/shutdown tests, включая зависший kick и обе process entrypoints. |
| 11 | Восстановлены notify.sent/skipped/blocked/failed/safety_cap и jitter 0–1000ms для Telegram 429. APNs stats имеют отдельный apns:hour id; Telegram forbidden-rate denominator не включает push. Покрыто delivery/stats tests. |
| 12 | trial_started и уже queued daily без push template идут в Telegram даже с активным устройством и alsoTelegram=false. Покрыто delivery/routing tests. |
| 13 | Регистрации сериализуются по строке профиля; при превышении 10 enabled devices старейшие last_seen_at отключаются с DeviceLimitExceeded. Покрыто devices tests: последовательная/конкурентная регистрация, обновление и смена владельца. |
| 14 | Кредитка без minimum amount получает утверждённый вариант без суммы (uz/ru/en), uz/en month капитализируется, ru остаётся lowercase genitive, weekly без top category опускает clause. Поддержаны старые queued placeholders. Покрыто templates/scheduled tests. |

Коммиты review fixes:

- `0ce5b3b` — legacy notifications в профиле.
- `88874e1` — корректные тексты без недостающих данных.
- `5186b35` — readiness, bundle/topic errors, device cap и HTTP/2 unref.
- `b19d459` — Telegram compatibility, кампании и наблюдаемость.
- `57f8a89` — env-independent storage, безопасный outbox и разделение budget timing.
- `7ec01c9` — bounded drain и закрытие APNs при shutdown.

Финальная последовательность команд из review выполнена без изменений: typecheck → npm test → build с DOTENV_CONFIG_PATH=/dev/null и тестовыми app vars только для тестов. Результат: 525 passed, 53 skipped; ESLint затронутых модулей/тестов и git diff --check также зелёные. Обновлён `docs/ai/api.md`. Реальные миграции, APNs, push/merge/deploy и чтение реальных env/ключей не выполнялись. Проверка SQL locking остаётся unit/mock: живые MySQL concurrency suites намеренно не запускались.
