# Production cutover Firestore → MySQL

## Выполнено 13 октября 2026

Переключение разрешено владельцем и выполнено. Production API `fd3a49a` работает
с `pulim_app`; UI `5ab75ac` развёрнут из migration branch (PR #1 остаётся открытым).
Payment сохранён на `f37069e`, его код и тарифы не обновлялись. Все пять PM2-процессов
online; внешние API/Payment readiness и сайт вернули HTTP 200.

Финальный snapshot: 3242 документа. Непосредственно перед открытием SQL verify:
compared=3242, mismatches=0, projectionMismatches=0, countMismatches=0.
Firestore freeze verification до и после открытия: compared=3242, changed=0.
Paid entitlements: 2, несовпадений billingVersion и срока Premium при проверке
в UTC нет. Payment outbox: DELIVERED=11, прежний DEAD=1 сохранён.

Защищённые snapshots, исходные конфигурации, старый API artifact и временные отметки
freeze/T1/open сохранены в `/root/pulim-backups/firestore-mysql-20261013`.
Первый post-cutover dump обеих баз создан в `mysql-daily/20261013T185241Z`.
Ежедневный root cron: 03:17 по часовому поясу сервера, backup app и Payment,
проверка gzip и SHA256; автоматическое удаление копий выключено.
Firebase Auth и исходный Firestore сохранены. После T1 действует процедура
fix-forward/актуального reverse mapping ниже, а не возврат к старому snapshot.

Дата подготовки: 13 октября 2026. Production: SSH `myserver`, Node 24.15,
MySQL 8.0.46; API `/root/pulim-api-v2`, UI `/root/pulim-ui-v2`,
Payment `/root/pulim-payment-api`.

## Подготовлено и проверено

- Новый API собирается локально и в отдельной серверной папке
  `/root/pulim-api-mysql-stage-20261013`, не обслуживающей пользователей.
- Отдельная пустая `pulim_app`; runtime user имеет только SELECT/INSERT/UPDATE/DELETE
  в ней. Отдельный migrator имеет DDL-права только в `pulim_app`.
- Закрытый запуск на `127.0.0.1:3112`, без jobs, проверен на production MySQL 8.0.
- Репетиционная копия Firestore `pulim-ai/pulim`: 3242 документа, 28 root collections,
  неизвестных коллекций, подколлекций и небезопасных чисел не найдено.
- Import/verify: ноль расхождений содержимого, проекций и количества. SQL export →
  reverse plan: ноль изменений. MySQL dump восстановлен в другую локальную базу;
  повторная полная сверка также без расхождений.
- Текущие правила named DB запрещают client writes (`allow write: if false`).
  Снимок правил сохранён; обнаружено 0 composite indexes и 0 TTL fields.
- Cloud Functions API сообщает SERVICE_DISABLED. На сервере только пять процессов
  Pulim (UI, API, worker, Payment, Payment worker), Pulim cron отсутствует.
- Payment production на `f37069e`; локальные последующие изменения Payment,
  включая тестовый тариф, **не входят в это переключение**. Перезапускать существующий
  Payment binary, а не выполнять общий deploy/payment migration.
- Есть 18 PENDING payments и один прежний DEAD event с `source=trial/isTrial=true`,
  отвергнутый paid receiver с 400. Его не переписывать и не replay: контракт paid
  receiver намеренно принимает `atmos|none`, `isTrial=false`. Оплаченных событий 11.

## Граница разрешения

Подготовка кода и локальная копия выполнены по поручению пользователя. Реальное окно
работ включает временную недоступность и финальные серверные резервные копии в
`/root/pulim-backups/firestore-mysql-20261013`; оператор фиксирует разрешение на этот
конкретный шаг перед заморозкой. Копии содержат финансовые/личные данные и конфигурацию:
директории 0700, файлы 0600, ничего не отправлять в Git или логи.

## Freeze и финальная копия

1. Сохранить revisions API/UI/Payment, PM2 описание с защищённым хранением,
   исходные `.env`, nginx configs, старый `dist` и backend dependencies/deploy artifacts.
   Проверить место на диске. Сохранить Payment MySQL dump отдельно от app DB.
2. Установить временный nginx maintenance guard для **обоих** HTTPS server blocks:
   `api.m-pulim.uz` и `payment.m-pulim.uz`. Guard возвращает 503 для всех методов,
   включая GET, Auth, Telegram, Shortcuts, billing и payment return/refresh.
   Проверить `nginx -t`, reload и фактические HTTP 503. Liveness/readiness проверяются
   оператором через localhost. Не отключать Telegram через флаг, возвращающий 204.
3. Остановить `pulim-payment-worker`, `pulim-payment`, `pulim-worker`, `pulim-api`.
   Дождаться завершения; проверить PM2 states и отсутствие процессов/писателей.
   Не сбрасывать Telegram pending updates. Оставить UI доступным с maintenance API.
4. Выдержать drain-паузу перед снимком. Export использует фиксированный readTime
   примерно на 5 секунд раньше старта, поэтому он должен быть **после** полной остановки
   writers. Финальный readTime должен попасть внутрь freeze, а не до него.
5. В stage выполнить с исходными Firebase credentials:
   `node --env-file=.env.migrate --import tsx scripts/migration/cli.ts export-firestore
   --project pulim-ai --database pulim --directory <backup>/firestore-final`.
   Манифест создаётся только после полного обхода. Source остаётся нетронутым.
6. Импортировать в пустую `pulim_app` через `.env.migrate`:
   `... cli.ts import-mysql --target-database pulim_app --directory <backup>/firestore-final`.
   Затем `... cli.ts verify --target-database pulim_app --directory ...`.
   Требование: ok=true, все mismatch counters=0.
7. Запустить `... cli.ts verify-source-frozen --directory ...` с Firebase credentials:
   root IDs и Firestore updateTime должны полностью совпасть с финальным архивом.
   Инструмент отклоняет nested archive, а не делает неполную проверку молча.

## Закрытая проверка и открытие

8. Новый release должен быть зафиксирован в Git; API/UI обновляются до точных revisions.
   Payment код/тарифы не обновляются. Старые revisions и artifacts сохранены отдельно.
9. Runtime `.env`: прежние Auth/Telegram/billing настройки плюс новая MySQL connection;
   `MYSQL_USER=pulim_app`, пароль только в приватном файле, `BIND_HOST=127.0.0.1`,
   `PORT=3111`, `BACKGROUND_JOBS_ENABLED=false`. Для закрытых операторских проверок
   app `MAINTENANCE_MODE=false`, но nginx guard остаётся включённым.
10. Запустить API и проверить localhost `/health/ready`, полный SQL verify, чтение
    профилей и контрактов. Не вызывать bootstrap/billing/worker на реальных профилях
    в этом этапе. Synthetic smoke writes учитывать отдельно и убрать до финальной сверки.
11. Зафиксировать T1 непосредственно перед разрешением новых рабочих writes.
    Удалить API maintenance guard; затем включить jobs контролируемым restart API и
    запустить ровно один worker. Проверить внешние health и отсутствие runtime Firestore.
12. Снять Payment maintenance, возобновить существующие Payment API/worker, проверить
    outbox PENDING/DEAD и paid entitlements. Прежний invalid trial DEAD оставить прежним;
    новые необъяснённые DEAD и billing-version расхождения расследовать.
13. Проверить восстановление Telegram queue/leases и FX jobs, состояние Premium,
    API error rate, source freeze и чтение старого UI. Сохранить post-cutover app backup.
14. Установить ежедневный root socket backup для app и Payment через
    `scripts/migration/backup-mysql.sh` с отдельным защищённым backup directory.
    Первоначально retention deletion выключен; включать только явным значением >=30 дней.
    Периодически повторять restore в изолированную базу. Старый Firestore не удалять.

## Ошибка и откат

До T1: оставить maintenance, остановить SQL API, вернуть старые code/config/artifacts,
запустить старый API/worker с исходным Firestore, затем открыть и возобновить Payment.
Никакие новые рабочие SQL writes в этом режиме не должны были приниматься.

После T1: сразу maintenance и остановка writers. Сохранить текущую app MySQL и отдельную
Payment backup. Предпочтительно исправить SQL release. Для возврата выгрузить актуальное
SQL-состояние через `export-mysql`, построить `restore-plan` относительно финального
Firestore bundle и проверить creates/updates/deletes. Восстановить в отдельную recovery DB
через `restore-firestore --apply --writers-stopped --recovery-database --reviewed-plan ...`;
либо после дополнительного source backup применить проверенный diff к исходной DB с
`--apply-deletes`. Сверить данные и восстановить rules/indexes/TTL отдельно от документов.
Обратная cloud-запись ещё не выполнялась в репетиции: локально проверены codecs, diff
и SQL round-trip. До проверки cloud restore быстрое data-safe возвращение не обещается.
Payment DB нельзя откатывать старым dump вслед за app: оплаченные заказы и Firebase Auth
users продолжают существовать. Без актуального reverse mapping простой возврат на старый
Firestore после T1 теряет новые edits/deletes/operations и запрещён.
