# @t3tools/ft3-architect

Legacy-связка координатор↔архитектор: создание/замена/отзыв, цикл архитектурного
ревью, публикация человеком и побудки через штатный `message.dispatch`. Поток
связки устарел: один босс — lead, а архитекторы (`architect`, `architect-*`) —
консультанты на один вопрос через `delegate_task`, без привязки. Инструменты
пакета остаются для существующих связок и их данных; скилл
`create-orchestrator-architect` помечен retired.

## Экспорты

- `./server` — MCP-toolkit (`architect_create_or_get`, `architect_replace`,
  `architect_detach`, `architecture_review_*`, `prepare_lead_publication`,
  `publish_to_lead`, чтение связки и ревью);
- `./service` — `ArchitectService` (SQL-доступ остаётся внутри пакета);
- `./reactor` — `ArchitectReconciler` после рестарта;
- `./migrations` — `4_Architect`, `5_ArchitectReviewWake`;
- `./skillLocation` — путь к retired-файлу `skills/create-orchestrator-architect/SKILL.md`;
- `./rpc`, `./rpc-contracts`, `./contracts` — WebSocket-методы, браузерные контракты, типы.

## Швы

Серверная регистрация — через `ft3-host`; отметка оркестратора читается из `ft3-board`,
а не дублируется. Web-часть — `ft3-web/src/architect` и `sidebar/ArchitectSidebarPin.tsx`.
Строки — в [fork-boundary.md](../../docs/internals/fork-boundary.md): «Серверная композиция
ft3», «RPC-модуль ft3 для web», «Architect sidebar and human publication (S4)».

## Тесты

`pnpm run test`: MCP-сервис и права, миграции, публикация и идемпотентность.
