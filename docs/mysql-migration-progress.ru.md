# Firestore → MySQL: аудит и начало реализации

Дата: 13 октября 2026. Аудит исходников трёх проектов, без чтения production-данных.
Основа: `pulim-payment-api/docs/firestore-to-mysql-codex.ru.md`.

## Вывод

Это перенос хранилища основного API с сохранением поведения, а не замена одного
подключения. Firebase Auth сохраняется. Payment остаётся владельцем своей MySQL-базы.
Постоянную двойную запись и эмулятор Firestore поверх SQL не вводим.

Проверенные исходные ревизии: API `9121316`, Payment `ff28ac5`, UI `02c81b7`.
В API и UI до начала изменений рабочие деревья чистые; в Payment уже находились два
неотслеживаемых документа миграции. Они не изменены.

## Где находится работа

| Проект | Проверенная область | Что предстоит | Оценка |
|---|---|---|---|
| API | 142 TS-файла, 14 619 строк; 41 файл с прямыми признаками Firestore; 60 `runTransaction`, 7 `batch`; 39 известных имён коллекций | SQL-инфраструктура и схема, репозитории, денежные сервисы, семьи, авторизация и trial, Telegram, AI, уведомления, рассылки, заметки, CLI | Основная часть; 10–16 инженерных дней |
| Payment | 29 TS-файлов, 3 015 строк; Firestore runtime отсутствует; MySQL/Kysely/mysql2 уже используются | Проверка billing receiver/outbox на новом API, восстановление pending/dead, инструкции паузы и сверки | 1–2 дня |
| UI | 132 TS/TSX-файла, 22 585 строк; данные через REST, вход через Firebase Auth | Удаление legacy Firestore, проверка старого UI-контракта, входа, семьи, оплаты и PWA | 1–2 дня |
| Перенос и эксплуатация | Реальный объём данных пока неизвестен | Типизированные export/import/verify/reverse, контроль сторонних writers, репетиция, backup/restore, переключение | 4–7 дней |

Суммарный ориентир: **16–27 инженерных дней**, примерно 3–6 рабочих недель одного
разработчика. Это оценка сложности, не обещание календарного срока работы агента.
Обновить после inventory реальной базы и первой репетиции. Файлы/строки — объём
исходников до текущих изменений, не обещание переписать каждую строку.

## Подтверждённые особенности

- Сохранённые balances копируются, не пересчитываются из истории: clear history не
  возвращает деньги на счёт. У credit расход увеличивает использованный долг.
- Перевод создаёт одну transaction и меняет два счёта. Возвраты меняют original,
  linked transaction и баланс совместно.
- Семьи используют `household:<id>`, категории без `userId` и личные счета с
  ограничением видимости баланса. Нельзя заменить всё обязательным profile FK.
- Telegram operation markers и drafts входят в денежную транзакцию. Их перенос
  необходим для защиты от повторного списания.
- Firestore merge/update/delete/increment/array operations требуют явных SQL
  эквивалентов; dotted keys в `set` и `update` нельзя трактовать одинаково вслепую.
- Billing сохраняет eventId и монотонную version. Trial history не сбрасывается.
- Payment доставляет события как worker, так и inline из refresh/return routes.
  Одной остановки worker недостаточно для заморозки всех writers.
- API стартует recovery и FX loops; standalone worker выполняет рассылки даже при
  выключенных финансовых уведомлениях. Нужен отдельный контролируемый режим запуска
  для закрытой проверки SQL-версии.
- В UI не найдено потребителей `runImport`. Удалена старая утилита с прямой записью
  Firestore. Обнаружено и удалено отдельное PWA-правило кеширования Firestore.
- `PROJECT_CONTEXT.md` фронтенда описывал старые client-side writes/listeners;
  добавлена заметная поправка к текущей архитектуре.
- Исходные тесты почти полностью проверяют чистую логику и моки. Их успешный запуск
  не доказывает SQL-атомарность: потребуются реальные MySQL concurrency tests.

## Сделано в первом этапе

- Отдельный `src/config/firebaseAuth.ts`: Auth можно инициализировать без Firestore.
  Старый DB-модуль временно остаётся для ещё не перенесённых сервисов.
- Auth-only imports направлены в новый модуль, UID/credentials/token rules прежние.
- UI больше не инициализирует Firestore и не содержит его imports в `src`.
- Добавлен read-only `data:inventory` на низкоуровневом Firestore SDK. Он обходит
  root/subcollections, включая отсутствующих родителей (`showMissing`), агрегирует
  типы и длины полей/ID, отмечает неизвестные коллекции, unsafe int64, NaN/Infinity.
  Отдельные document IDs и значения полей в отчёт не включаются. Имена динамических
  полей могут быть чувствительными: отчёт остаётся локальным с правами `0600`.
- Добавлены тесты отсутствующих родителей, неизвестных подколлекций, точности чисел,
  dotted/nested keys, лимита сканирования и независимости Auth от Firestore.
- Подготовлена и запущена отдельная локальная MySQL 8.4, проверено соединение с
  `pulim_app_rehearsal`. Production-копии, таблицы приложения и SQL runtime ещё не
  создавались.

## Локальная репетиция

Пользователь выбрал локальную среду. У неё отдельные schema/user/volume/port, она не
использует Payment DB или production credentials.

```sh
docker compose -f compose.migration.yaml up -d --wait
docker compose -f compose.migration.yaml ps
```

Подключение: `127.0.0.1:3308`, database/user `pulim_app_rehearsal`, локальный пароль
`local-rehearsal-only`. Эти credentials только для локальной среды.
Остановить с сохранением данных: `docker compose -f compose.migration.yaml stop`.
Не использовать `down -v`, если нужно сохранить результаты репетиции.

## Read-only inventory

Скрипт **не загружает `.env` автоматически**, не импортирует API/worker, не запускает
таймеры и не вызывает cloud writes. project/database/output обязательны, default DB
передаётся явно как `(default)`. Для выбранного источника использовать отдельный
read-only credential, по возможности через ADC или `FIREBASE_SERVICE_ACCOUNT_PATH`.
Если переменные source в окружении заданы, они должны совпадать с аргументами.

```sh
mkdir -p .migration-artifacts
npm run data:inventory -- --help
node --env-file=/private/path/read-only-migration.env --import tsx \
  scripts/migration/inventory-firestore.ts \
  --project YOUR_PROJECT --database '(default)' \
  --out .migration-artifacts/inventory.json --max-documents 100000
```

Повторный запуск требует нового имени output. При ошибке или превышении лимита —
nonzero exit и отсутствует полный отчёт; пустой/частичный файл нельзя считать
результатом. Обход читает все документы и делает запросы коллекций под каждым
документом: это потребляет Firestore reads/API quota. `occurrences` в полях массивов
считает элементы, а не уникальные документы.

Это inventory живой базы, **не согласованный snapshot и не export**. Он не сверяет
ссылки, SQL collation collisions, TTL, IAM, backups или Payment outbox. Эти проверки
остаются в следующем preflight; `completeTraversal` означает завершение обхода,
а не готовность переключать production. Production inventory в этом этапе не запускался.

## Проверки

До изменений: API 148 тестов, Payment 12 тестов; typecheck/build обоих backend
успешны; UI build и check:i18n успешны (1111 ключей).
После изменений: API 153 теста, build и отдельный typecheck migration scripts
успешны; UI build/check:i18n успешны; Compose config валиден, MySQL healthy и
принимает запрос от отдельного rehearsal user. Остаются прежние предупреждения UI
о крупном bundle и устаревшей базе Browserslist.

## Следующие этапы

1. SQL pool/transaction context/migrations и обратимые codecs. Пробный schema только
   на синтетических fixtures, окончательные ограничения после production inventory.
2. Profile/settings/bootstrap/trial/Auth mappings, затем базовый CRUD. Сравнить DTO
   со старой ревизией, включая missing/null и сортировки/limit.
3. Денежные операции и семьи: lock ordering, deadlock retry, rollback, parallel once
   actions, privacy и контрактные fixtures.
4. Telegram/AI/FX/queues/communications/dev notes/CLI; отдельный режим без timers и
   внешних отправок, readiness и graceful shutdown.
5. Billing integration, полный типизированный export/import/verify/reverse и
   репетиция backup/restore на локальной среде.
6. Только после нуля необъяснённых расхождений назначить окно и переключение.

## Что потребуется от владельца

Сейчас код и локальную среду можно готовить без дополнительного участия.
До production inventory нужны точные Firebase project/database ID и расположение
разрешённых credentials/доступа к серверу; секреты в чат не нужны. Нужно выяснить,
пишут ли в базу админка, Cloud Functions, cron или другие проекты помимо этих трёх.
Перед реальным переносом понадобятся согласованное окно недоступности и доступ к
проверенным backup/restore. Длительность окна определяется репетицией. Быстрый откат
после новых MySQL writes не обещаем без проверенного обратного переноса.

В этом этапе нет deployment, переключения production, изменения правил Firebase,
экспорта клиентских данных или удаления исходного Firestore.

## Обновление реализации — 13 октября, вечер

Предыдущие разделы фиксируют исходную оценку и первый этап. Теперь runtime переведён
на MySQL во всех сервисах, worker и CLI: старые Firestore init/helpers удалены.
Используются явные SQL document keys/query specifications, Kysely и транзакционный
контекст; методов `.collection().doc().where()` и Firestore snapshots в runtime нет.
Денежные мутации планируются в одном контексте и исполняются перед SQL commit;
при deadlock/lock timeout повторяется весь callback, внешние вызовы остаются снаружи.
Схема: 39 entity tables + sidecar type metadata, индексные проекции и household_members,
история схемы и миграционных запусков. JSON и проекции пишутся совместно.

Добавлены типизированные export/import/verify/export-current/reverse-plan/restore tools,
явный maintenance и отключение всех background jobs, SQL readiness и drain/shutdown,
защищённый backup script. Действующие Firestore rules/indexes/TTL сохранены отдельно.

Реальная read-only инвентаризация: 3242 документа, 28 коллекций, 0 unknown/subcollections,
0 unsafe integers/nonfinite/unsupported values. Полный snapshot импортирован в отдельную
локальную `pulim_app_rehearsal_20261013`: compared=3242, все три mismatch counters=0.
SQL current export даёт reverse plan actions=0. Dump восстановлен в отдельную локальную
`pulim_app_rehearsal_restore`, повторная сверка тоже compared=3242, mismatches=0.
Реальные копии находятся только в игнорируемом защищённом `.migration-artifacts`.

Обычные tests: 158 passed; отдельно выполняются реальные MySQL integration tests
(18 passed), включая rollback, concurrency/dedupe, opposing transfers, refunds,
clear history, debt/savings/subscription/deposit, trial, family privacy/membership,
SMS consume, queues, signed billing и archive/import/export/reverse diff.
Обычный `npm test` пропускает destructive local DB integration suite по умолчанию;
он запускается явно через `npm run test:mysql`, только на `127.0.0.1:3308` в тестовой
`pulim_app_rehearsal`, и не может очистить базу с реальными копиями.

Production preflight: server Node 24.15.0 / MySQL 8.0.46, root-only stage build и
закрытый health на 3112 прошли; отдельная пустая `pulim_app` и runtime/migrator users
подготовлены, текущие API/UI/Payment продолжают работать в старом режиме.
Cloud Functions API disabled; client writes уже запрещены; composite indexes=0, TTL=0.
Операционный шаг остаётся в [cutover runbook](mysql-cutover.ru.md).
