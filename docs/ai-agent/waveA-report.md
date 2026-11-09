Реализован Wave A: шесть read-only инструментов, серверные расчёты, потоковый Responses API, статусы SSE, heartbeat, followups и usage по каждому вызову. Rollback: `AI_AGENT_ENABLED=false`. Premium-лимит по умолчанию — 150.

Добавлены `src/ai/agent/*` (включая общие client/settings/usage), `src/cli/chatEval*.ts`, `tests/aiAgent/*`, два synthetic fixture-файла и `tests/httpTest.ts`. Изменены AI controller/service, Telegram quickEntry, env schema, экспорт safeText, package.json, ESLint config и `docs/ai/api.md`. Шесть существующих HTTP-suite используют внутрипроцессный адаптер без TCP, сохраняя проверки.

Канонические правила перенесены из `pulim-ui-v2/src/pages/Charts.tsx`, `src/pages/Transactions.tsx`, `src/utils/transactionKind.ts`; нормализация UZS — из `buildContext.ts`. Возврат уменьшает расход в день возврата; `returnedAmount` повторно не вычитается. Соседний репозиторий не изменён.

В установленном SDK проверены FunctionTool/strict, required/nullable arguments, function_call/call_id/arguments, function_call_output/output, ResponseInput/output replay, reasoning.encrypted_content, stream/store/include, tool_choice/parallel_tool_calls, cache/safety identifiers, max_output_tokens, reasoning.effort, text.verbosity, delta/completed/incomplete/failed/error и usage. Цены не изменялись.

Проверки зелёные: typecheck, lint, build; `npm test -- --configLoader runner` — 981 passed, 53 skipped. Runner нужен из-за read-only ссылки node_modules. Проверки выполнялись с DOTENV_CONFIG_PATH=/dev/null и синтетическими обязательными env-значениями; сеть и MySQL не использовались.

Не проверены: live eval (по запрету brief), реальные DB/production, точная токенизация контекста (консервативный byte-budget). Eval содержит 40 вопросов: 32 независимых числовых эталона и 8 качественных рубрик.

Открытый вопрос: требование обновить `.env.example` конфликтует с запретом открывать `.env*`; файл не открывался и не изменялся, параметры описаны в API docs. Коммитов, push, deploy и миграций нет.
