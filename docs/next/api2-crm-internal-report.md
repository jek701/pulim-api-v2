# API2 — CRM integration: итоговый отчёт

Дата: 2026-11-16. Репозиторий `pulim-api-v2`, worktree `claude/release-1.0`.
Коммитов, установки зависимостей, миграций, обращений к production и изменений prod env нет.
Секции 2 и 3 `/Users/macbookair/WebstormProjects/pulim-crm-api/docs/contract.md` прочитаны.

## Результат и включение

Реализованы четыре внутренних CRM-маршрута, `tips`, запись AI consent и deletion fan-out.
Без `PULIM_CRM_INTERNAL_SECRET` всё дерево `/internal/v1/crm/*` отвечает 404 ещё до
JSON parser и request logger; ни DB-запроса, ни per-request лога. Отложенные CRM push
также не отправляются без секрета. Публичные настройки и consent доступны для выпуска МП
до запуска CRM. Web/Telegram Mini App не менялись.

Новые переменные для владельца, только имена:

- `PULIM_CRM_INTERNAL_SECRET`
- `PULIM_CRM_API_URL`

Secret опционален, минимум 32 символа при задании. URL опционален. Существующие
`NOTIFICATIONS_ENABLED`, `PUSH_ENABLED`, background/maintenance switches, APNs credentials
и recipient allowlist сохраняют силу. Изменение server env/включение доставки не выполнялось.

Новая таблица, колонка, миграция или индекс **не нужны**. Используются уже существующие
`profiles`, `notifications`, `notification_tasks`, `push_devices`, entity tables и
`household_members`. Обычные prerequisites базы (включая существующую push registry migration)
не меняются; отсутствие `push_devices` означает отсутствие активных устройств.

## HMAC и граница доступа

Общий `middleware/internalHmac.ts` сохраняет billing-схему `timestamp.rawBody`, прежние
коды/сообщения ошибок, отдельный secret и event-id dedupe в billing_events. CRM использует
`timestamp.requestId.rawBody`, UUID request-id, ±5 минут и timing-safe hex comparison.
GET подписывает пустое тело. Raw body уже захватывается общим JSON parser.

CRM router смонтирован отдельно от `/v1`: без Firebase auth, end-user rate limit и
Idempotency-Key middleware. Неожиданные SQL/SDK ошибки превращаются в безопасный 503
`CRM_UNAVAILABLE`, без raw error/SQL в логах. Подписи исключены из request logger.

Request-id replay cache: process-local Map, хранение 10 минут, максимум 100000 записей;
при заполнении — 503, без вытеснения ещё действующих id. После рестарта/между несколькими
API-процессами этот cache не даёт глобальной replay-гарантии. Business-дедупликация `mid`
остаётся durable и общей для всех процессов. Повтор HTTP-запроса следует подписывать новым
request-id с тем же mid. Это ограничение отдельно от гарантии отсутствия повторной постановки.

## UserFacts: точные источники и стоимость

Из ответа формируется только фиксированный набор ключей контракта; профиль целиком,
consents, имена, Telegram ids, телефоны, e-mail, суммы и заметки в ответ не попадают.

Регистрация определяется положительными сохранёнными auth metadata: `isTelegramUser`,
непустые `linkedAuthMethods`, `primaryAuthMethod` или `lastAuthMethod`. Anonymous bootstrap
не имеет этих признаков; deleting profiles исключены. Старые профили без любых registration
metadata консервативно исключаются до очередного bootstrap. Firebase directory не опрашивается.

| Поле | Вычисление | Дополнительная стоимость на страницу |
|---|---|---|
| uid | Primary key профиля | Уже прочитан |
| createdAt | profile.createdAt, иначе 0 | Уже прочитан |
| updatedAt | profile.updatedAt, иначе 0 | Уже прочитан |
| language | Нормализация profile.language к ru/uz/en, default uz | O(1)/uid |
| timezone | notifications.timezone → profile.timezone → Asia/Tashkent; валидный IANA, иначе default | O(1)/uid |
| tier | premium только при isPremium === true и subscription.premiumUntil > now | O(1)/uid |
| premiumUntil | subscription.premiumUntil, иначе 0; истёкшее значение сохраняется | Уже прочитан |
| isTrial | Активный Premium и subscription.isTrial === true | O(1)/uid |
| trialUsed | trialGrantedAt задан, либо isTrial === true, либо source === trial | O(1)/uid |
| hasPushDevice | Есть push_devices с disabled_at IS NULL | Один batch по push_owner_enabled |
| pushEnabled | Нормализованный notifications.enabled, default true | Уже прочитан |
| marketingPushAllowed | enabled AND groups.tips === true; default false | Уже прочитан |
| appVersion | app_version самого свежего по last_seen_at активного устройства, иначе пустая строка; только version-like строка | Тот же device batch, ≤10 активных устройств/uid по registry policy |
| telegramLinked | isTelegramUser, linkedAuthMethods содержит telegram или непустые telegramChatIds; ids не возвращаются | Уже прочитан |
| lastTransactionAt | MAX(transactions.date_ms) GROUP BY user_id | Один covering owner_date batch; MAX следующей части ключа допускает loose index grouping |
| transactions30d | COUNT(*) по user_id и date_ms в [now−30d, now] | Один grouped owner_date range batch |
| counts.accounts | COUNT(cards) по user_id | Один grouped owner_date batch |
| counts.budgets | COUNT(budgets) по user_id | Один grouped owner_date batch |
| counts.plans | COUNT(planned_expenses) по user_id | Один grouped owner_date batch |
| counts.goals | COUNT(savings_goals) по user_id | Один grouped owner_date batch |
| counts.debts | COUNT(debts) по user_id | Один grouped owner_date batch |
| counts.subscriptions | COUNT(subscriptions) по user_id | Один grouped owner_date batch |
| counts.categoriesCustom | COUNT(categories) по user_id, исключён id с префиксом `${uid}__default__` | Один grouped owner_date batch, проверка PK в выбранных owner ranges |
| aiMessages30d | 0 | Нет запроса |
| captures30d | 0 | Нет запроса |
| inHousehold | Наличие строки в household_members по user_id | Один batch по member_user |

Entity counts относятся к документам с данным user_id. Transaction facts используют
бухгалтерскую дату документа, не время создания: считаются все owned операции, включая transfers;
это не финансовая статистика. Последняя дата может быть будущей, если операция датирована будущим.
Никакая арифметика балансов/сумм не изменялась.

`aiMessages30d`: ai_chats содержит вложенные сообщения с timestamp без подходящего message-time
индекса; ai_usage описывает модельные вызовы/rounds/features и не является точным счётчиком
пользовательских сообщений. Для точного значения нужны серверные дневные счётчики сообщений
или отдельный индексируемый журнал с message identity. `captures30d`: capture_usage содержит
месячные buckets, capture_issued — последнее распознавание по merchant, а сохранённая transaction
не покрывает незавершённые captures. Нужны дневные счётчики/индексируемые recognition events.
Сканирование истории ради этих двух фактов не добавлялось.

GET /users читает максимум 501 профиль по binary PK (`id > lastKey`, LIMIT limit+1).
Cursor — canonical base64url последнего **просмотренного** profile key; неверный cursor — 400.
Anonymous/deleting rows пропускаются после чтения, поэтому страница может содержать меньше
limit users или быть пустой с ненулевым nextCursor. Итерировать нужно до nextCursor === null.
`updatedSince` валидируется, но **игнорируется**: updated_at_ms не имеет индекса.
POST /users/facts использует один PK IN batch, неизвестные/удалённые uid отсутствуют.

Одна непустая страница: **12 SQL statements** — profiles + 7 counts + 2 transaction metrics
+ devices + household membership. Для страницы без зарегистрированных профилей — 1.
Все owner-dependent запросы ограничены списком ≤500 uid (≤200 для facts POST), без N+1
round trips, без глобального scan 50000 profiles. Ответы агрегатов — максимум 500 строк каждый.

Оценка для 50000 пользователей: примерно 100 страниц / 1200 SQL statements на полный проход.
При 50 owned entity docs и 60 транзакциях за 30 дней на пользователя страница затронет порядка
25000 entity index entries, 30000 recent transaction entries, до 5000 active device rows,
порядка 500 membership rows, до 501 profile JSON. Latest-date MAX должен обслуживаться covering
owner_date/loose grouping; если optimizer выберет обычный range scan, работа зависит от всей
transaction history **этих 500 owners**, а не от количества всех пользователей. Count-запросы
также зависят от числа документов выбранных owners, а не имеют искусственного обрезания.
Это оценка, не production benchmark: production DB/EXPLAIN не запускались. Все нужные индексы
уже созданы существующими миграциями; новый индекс не требуется.

## Messages: idempotency, доставка и retention

Ключ `notifications.id = crm:<полный SHA256(mid)>`. Namespace отделён от обычных job ids;
key глобален по mid, как контракт CRM. В одной SQL transaction выполняются read/lock job и
profile, проверка admission, insert результата и при необходимости profile marketing marker.
Повтор с тем же mid возвращает **первоначальный admission outcome**, даже если доставка
уже завершилась или повтор имеет другой uid/content. Актуальный результат — status endpoint.
Concurrent repeats не создают две queue rows; стандартный transaction runner повторяет deadlocks.

Admission reasons: unknown_user (отсутствует/anonymous/deleting), no_device, opted_out,
daily_cap, disabled (серверные switches/allowlist), expired (quiet hours исчерпывают TTL).
Skipped jobs хранят минимальный результат, без текста сообщения; unknown_user также не хранит
uid. Поэтому поздний запрос не восстанавливает персональные данные удалённого аккаунта.
Остальные owned outcomes удаляются обычным owner sweep.

Маркетинг требует master и tips === true, transactional — только master. У старого профиля
без notifications перед постановкой transactional атомарно создаются стандартные настройки.
Admission проверяет существующий sent+reserved cap min(6, NOTIFY_SAFETY_MAX_PER_USER_PER_DAY).
Это не reservation всех transactional jobs наперёд: definitive serialized safety reservation
выполняется существующим delivery worker перед отправкой.

Маркетинг дополнительно фиксирует crmMarketingQueuedDay (локальная дата planned delivery),
поэтому два сообщения в ночи не резервируют один следующий день. Delivery использует
crmMarketingReservedDay/crmMarketingSentDay под profile lock; успешная логическая отправка
учитывается один раз, независимо от числа устройств. Failed reservation освобождается.
Дневной admission marker консервативен: отменённый/неотправленный marketing job не освобождает
повторную постановку того же local day. Все CRM messages входят в общий daily cap.

Quiet hours применяются и на admission, и на delivery по настройкам пользователя. Отправка
переносится, но staleAt всегда равен initialAcceptedAt + ttlSec: CRM deferrals его не продлевают.
Истёкшая запись становится skipped/expired. CRM не получает time-sensitive bypass.
Выполняются существующие leases, retries, per-device acknowledgments и recovery.
Существующее ограничение очереди остаётся: crash после принятия APNs и до записи acknowledgment
может дать повтор доставки; durable mid гарантирует отсутствие второй **постановки**, а не
exactly-once исполнения внешним провайдером.

`type: crm`, `link`, `crm: {mid}` попадают в APNs. Title/body передаются дословно, включая
literal braces, без templates/AI. collapseKey ограничен 64 UTF-8 bytes и передаётся как collapse id;
expiration = floor(staleAt/1000). CRM всегда push-only, включая случай отсутствия APNs config
и terminal device errors; Telegram fallback исключён независимо от alsoTelegram.
NotificationType включает crm через PushType; per-type latency stats и APNs totals учитывают CRM,
а notification_stats также сохраняет crmAttempts/crmSent.

Status выполняет один PK IN batch ≤500 mids: pending/sending → queued, cancelled → skipped,
прочие terminal states передаются. reason — безопасный skip code либо delivery_failed;
provider error text не возвращается. at = sentAt, иначе updatedAt/createdAt; unknown → null/null.

Queue docs используют существующий `expiresAt = createdAt + 90d`, **но автоматического TTL purge
сейчас нет**: outcomes фактически доступны до account deletion или ручного/будущего purge,
а не гарантированно ровно 90 дней. После purge — unknown; после потери dedupe row повторный mid
может снова создать job. Обезличенные unknown_user markers не связаны с владельцем и остаются
до общего purge. Retention policy этим изменением не добавляется.

## Tips и AI consent

`groups.tips` default false и `notifications.tipsUpdatedAt` — только серверный timestamp
реального изменения consent. Repeated PATCH не переписывает evidence. Read/patch normalize
legacy missing key; существующие notification types не зависят от tips.

PUT /v1/profile/consents/ai: strict validation, anonymous 403, profile transaction, 204.
Сохраняются granted/version/language/screen, clamped at, serverAt и revokedAt.
True→false ставит revokedAt; повтор false сохраняет прежний revokedAt; grant очищает его.
Identical requests сохраняют первоначальный serverAt, включая повтор clamped timestamp.
Маршрут включён в allowlist обычного Idempotency-Key middleware как single-transaction mutation.
**На AI routes согласие в этом релизе не проверяется**, чтобы не сломать старые клиенты.
Запись живёт исключительно внутри profile: обычное удаление profile удаляет consent целиком.

## Deletion fan-out

После последнего owner sweep сохраняется operational tombstone в существующей
notification_tasks: key crm-delete:sha256(uid), status crm_delete_pending, uid, runAt, attempts.
userId намеренно отсутствует: owner purge его не удаляет при повторном deleteAccount.
После удаления profile выполняется signed POST, **перед Firebase deleteUser**. Refresh tokens
к этому моменту уже отозваны. Такой порядок не задерживает очистку CRM из-за сбоя Firebase;
HTTP-failure не меняет результат локального удаления. Worker проверяет отсутствие profile,
поэтому сохранённая перед profile removal задача не очищает CRM преждевременно.

Peer endpoint `/internal/v1/users/deleted`, body {uid}, свежий UUID/подпись на каждую попытку,
timeout 5 s, только 204 считается успехом, redirects запрещены, response body не логируется.
Первая неудача логируется одной строкой с uidHash. При успехе tombstone удаляется.

Dedicated worker drain: максимум 10 due jobs за цикл 30 s, lease 30 s через runAt,
exponential backoff до часа, повторяется до подтверждения. Existing queue_run(status,run_at_ms)
используется без нового индекса. Обычный budget task worker не видит отдельный status.
Drain работает и при NOTIFICATIONS_ENABLED=false, если background jobs включены; поддержан
также embedded API mode. Shutdown дожидается текущего drain.

Если durable save не удался, deletion всё равно продолжается: 3 in-process HTTP попытки,
паузы 250/500 ms. **Эта аварийная ветка теряется при process crash**; до 15.75 s задержки
при трёх HTTP timeout. Сохранённая задача переживает crash, API/worker restart и profile deletion.
Background maintenance/disabled worker откладывает retry до возобновления worker.

С UID-only контрактом нельзя отличить два поколения детерминированного Telegram uid.
Если перед retry уже появился новый незачёркнутый profile, старая задача удаляется, чтобы
не стереть CRM нового аккаунта. Между проверкой profile и HTTP остаётся узкая race с новой
регистрацией; для полного устранения нужен согласованный account-generation/deletion token
в peer contract. Под текущий frozen contract это ограничение не расширяет payload.
Без URL или secret — тихий пропуск, без operational записи.

## Файлы

Новые:

- `src/middleware/internalHmac.ts`
- `src/crm/{schemas,facts,messages,deletion}.ts`
- `src/controllers/crmInternal.controller.ts`
- `src/routes/crmInternal.routes.ts`
- `src/services/consent.service.ts`
- `tests/crm/{helpers,hmac,facts,messages,consent,deletion,routes,disabled}.ts`
- `docs/next/api2-crm-internal-report.md`

Изменённые:

- `.env.example`, `docs/ai/api.md`
- `src/app.ts`, `src/config/env.ts`, `src/domain/types.ts`
- `src/middleware/{idempotency,requestContext}.ts`
- `src/routes/{index,billingInternal.routes,profile.routes}.ts`
- `src/controllers/profile.controller.ts`
- `src/notifications/{delivery,queue.repository,settings}.ts`
- `src/push/{types,settings,schemas,routing,templates}.ts`
- `src/services/accountDeletion.service.ts`, `src/server.ts`, `src/worker.ts`
- `tests/account/deletion.test.ts`
- `tests/push/{delivery,queue,settings,stats,templates}.test.ts`

## Проверки

- `npm run typecheck` — PASS.
- `npm run build` — PASS (включая prebuild cleanup).
- `git diff --check` — PASS.
- Обычный `npm test` — Vitest не может записать bundled config в shared node_modules/.vite-temp
  из writable worktree (EPERM). Зависимости/общий symlink не изменялись.
- Для обхода только config bundling использован `npm test -- --configLoader native`.
- Целевой финальный прогон: CRM + account/billing + push delivery/queue/templates/settings/stats/shutdown:
  **23 files / 155 tests PASS**.
- Полный прогон и clean HEAD baseline запускались с тем же native loader в той же sandbox.
  Baseline создан через git archive HEAD в /tmp с symlink на существующий node_modules,
  без checkout текущих изменений и без npm install.
- Финальный full run: **89 files passed / 18 failed / 3 skipped; 1047 tests passed / 105 skipped**,
  4 unhandled EPERM listen errors. Clean HEAD: **82 files passed / те же 18 failed / 3 skipped;
  991 tests passed / 105 skipped**, те же 4 listen errors. Новых failed suites нет.
- 14 исходных env-dependent suites: `notifications/format`, `push/scheduled`, `push/capabilities`,
  `push/profile`, `profile/onboardingCategories`, `shortcut/shortcut`, `telegram/render`,
  `telegram/client`, `telegram/dispatcher`, `telegram/draftFormat`, `telegram/familyInvite`,
  `telegram/loadingDraft`, `telegram/loginRequest`, `telegram/media`.
- 4 исходных socket-dependent suites: `capture/routes`, `capture/syncCapabilities`,
  `devNotes/routes`, `push/routes`; sandbox запрещает listen на 127.0.0.1 (EPERM).
  Они воспроизведены на clean HEAD, изменения ради обхода этих ошибок не делались.
- Нативные SQL/APNs/Firebase/CRM интеграции с реальными сервисами не запускались;
  новые tests используют синтетические fixtures и mocked DB/HTTP. Поэтому production latency,
  планы MySQL optimizer и реальное подключение peer не являются результатом этой проверки.
