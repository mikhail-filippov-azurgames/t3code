# @t3tools/ft3-host

Серверная композиция форка. Пакет не содержит доменной логики: он собирает чужие
серверные возможности и служит основной точкой подключения серверной части к upstream.

## Экспорты

- `./server` — `layer`, `mcpToolkits`, `reactorLayer()`, `runMigrations`, `drainProcessOutput`;
- `./rpc` — серверная группа ft3, её handlers, scope-middleware и `serviceLayer`;
- `./rpc-contracts` — браузерная группа контрактов для `client-runtime` и web;
- `./process-output` — `drainProcessOutput` для Codex text generation.

## Что внутри

- `src/Migrations.ts` + `src/Migrations/` — журнал `ft3_migrations` и host-миграции.
- `src/import/` — одноразовый импорт старого форка: база, настройки, вложения, Pi agent-dir.
- `src/openContextDocs.ts` — резолвер документов OpenContext для чат-чипов.
- `src/rpc.test.ts` — карта scope и сквозной harness для всех ft3-методов.

## Швы

`apps/server/src/server.ts`, `mcp/McpHttpServer.ts`, `persistence/Sqlite.ts`, `ws.ts`,
`textGeneration/CodexTextGeneration.ts` и `client-runtime/src/rpc/protocol.ts`. Полные
строки и причины — в [fork-boundary.md](../../docs/internals/fork-boundary.md); карта
пакета — в [docs/ft3/README.md](../../docs/ft3/README.md).

## Тесты

`pnpm run test` в пакете: миграции, RPC/scope, импортёры, резолвер документов.
