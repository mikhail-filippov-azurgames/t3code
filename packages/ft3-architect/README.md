# @t3tools/ft3-architect

Связка координатор↔архитектор: создание/замена/отзыв, цикл архитектурного ревью,
публикация человеком и побудки через штатный `message.dispatch`.

## Экспорты

- `./server` — MCP-toolkit (`architect_create_or_get`, `architect_replace`,
  `architect_detach`, `architecture_review_*`, `prepare_coordinator_publication`,
  `publish_to_coordinator`, чтение связки и ревью);
- `./service` — `ArchitectService` (SQL-доступ остаётся внутри пакета);
- `./reactor` — `ArchitectReconciler` после рестарта;
- `./migrations` — `4_Architect`, `5_ArchitectReviewWake`;
- `./skillLocation` — путь к `skills/create-orchestrator-architect/SKILL.md`;
- `./rpc`, `./rpc-contracts`, `./contracts` — WebSocket-методы, браузерные контракты, типы.

## Швы

Серверная регистрация — через `ft3-host`; отметка оркестратора читается из `ft3-board`,
а не дублируется. Web-часть — `ft3-web/src/architect` и `sidebar/ArchitectSidebarPin.tsx`.
Строки — в [fork-boundary.md](../../docs/internals/fork-boundary.md): «Серверная композиция
ft3», «RPC-модуль ft3 для web», «Architect sidebar and human publication (S4)».

## Тесты

`pnpm run test`: MCP-сервис и права, миграции, публикация и идемпотентность.
