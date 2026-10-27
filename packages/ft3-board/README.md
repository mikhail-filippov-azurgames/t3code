# @t3tools/ft3-board

Доска координаторов: оркестраторы, карточки, история, удаления, автоматизация и MCP/RPC
для агентов и web.

## Экспорты

- `./server` — MCP-toolkit (`board_create_card`, `board_list_cards`, `board_update_card`,
  `board_delete_card`);
- `./service`, `./repository` — `BoardService` и SQL-доступ;
- `./delegation` — `BoardDelegationService`;
- `./reactor` — `BoardReactor`; `./automation` — retention, nudge, purge;
- `./migrations` — миграции `2_Board`, `3_BoardReactor`, `9_BoardRetention`;
- `./settings` — типизированный namespace `ft3` в `ServerSettings`;
- `./authorTextPolicy` — ре-экспорт политики секретов из `ft3-delegation`;
- `./rpc`, `./rpc-contracts`, `./contracts` — WebSocket-методы, браузерные контракты, типы.

## Швы

Подключение через `ft3-host` (Layer, MCP, RPC, `reactorLayer`), настройки через
`packages/contracts/src/settings.ts`, UI через `ft3-web`. Строки — в
[fork-boundary.md](../../docs/internals/fork-boundary.md): «Серверная композиция ft3»,
«RPC-модуль ft3 для web», «Board automation», «Board: полная страница /board».

## Тесты

`pnpm run test`: сервис и репозиторий, реактор, retention/nudge/purge, миграции, настройки.
