# ft3: карта форка

Правила изменения проекта — в [contributing.md](./contributing.md). Журнал правок
upstream-файлов — в [fork-boundary.md](../internals/fork-boundary.md); здесь только карта,
без повторения швов.

## Что такое ft3

ft3 — форк upstream T3 Code V2 (`pingdotgg/t3code`), ветка `ft3/v2`. Upstream остаётся
основой продукта, а логика форка живёт в `packages/ft3-*`. Пакеты подключаются к upstream
как расширения: через `package.json` exports, Effect-слои, MCP-toolkit'ы, одну группу
WebSocket RPC и несколько точек монтирования в web.

Граница проводится по трём правилам:

- собственная логика находится в `packages/ft3-*`;
- upstream-файлы получают только аддитивные швы: импорт, один вызов, слот, ранний возврат;
- каждая правка upstream-файла записывается в
  [fork-boundary.md](../internals/fork-boundary.md), иначе её нельзя сопровождать при
  rebase.

## Пакеты

| Пакет                        | Назначение                                                                                                                                                      | Экспорты `package.json`                                                                                                                                                                                                                                         | Сторона                    | Швы в `fork-boundary.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@t3tools/ft3-host`          | Серверная композиция: Effect Layer, MCP-toolkit'ы, ft3 RPC-группа, миграции и реакторы, legacy-импорт, резолвер документов OpenContext, дренаж вывода процессов | `./server`, `./rpc`, `./rpc-contracts`, `./process-output`                                                                                                                                                                                                      | server                     | [Серверная композиция ft3](../internals/fork-boundary.md#серверная-композиция-ft3), [RPC-модуль ft3 для web (S1)](../internals/fork-boundary.md#rpc-модуль-ft3-для-web-срез-s1), [Chat text chips and Typora](../internals/fork-boundary.md#chat-text-chips-and-typora), [Исправление Codex: не ждать закрытия пайпов](../internals/fork-boundary.md#исправление-codex-не-ждать-закрытия-пайпов)                                                                                                                                                                                                                                                                             |
| `@t3tools/ft3-board`         | Доска координаторов: оркестраторы, карточки, история, удаления, MCP-инструменты, реакторы автоматизации, настройки, RPC                                         | `./reactor`, `./automation`, `./server`, `./migrations`, `./repository`, `./settings`, `./authorTextPolicy`, `./routingPolicy`, `./rpc`, `./service`, `./delegation`, `./contracts`, `./rpc-contracts`                                                          | server + контракты для web | [Серверная композиция ft3](../internals/fork-boundary.md#серверная-композиция-ft3), [RPC-модуль ft3 для web (S1)](../internals/fork-boundary.md#rpc-модуль-ft3-для-web-срез-s1), [Board automation](../internals/fork-boundary.md#board-automation-retention-nudge-deleted-thread-purge), [Board: полная страница /board](../internals/fork-boundary.md#board-полная-страница-board-порт-ui-старого-форка), [Панель «Карточки/История» в чате](../internals/fork-boundary.md#панель-карточкиистория-в-чате-и-координаторская-кнопка-в-шапке), [Delegation secret boundary](../internals/fork-boundary.md#delegation-secret-boundary-s)                                       |
| `@t3tools/ft3-architect`     | Связка координатор↔архитектор, архитектурные ревью, публикация человеком, MCP-инструменты, reconciler после рестарта, skill для создания связки                 | `./server`, `./reactor`, `./migrations`, `./skillLocation`, `./rpc`, `./service`, `./rpc-contracts`, `./contracts`                                                                                                                                              | server + контракты для web | [Серверная композиция ft3](../internals/fork-boundary.md#серверная-композиция-ft3), [RPC-модуль ft3 для web (S1)](../internals/fork-boundary.md#rpc-модуль-ft3-для-web-срез-s1), [Architect sidebar and human publication (S4)](../internals/fork-boundary.md#architect-sidebar-and-human-publication-s4)                                                                                                                                                                                                                                                                                                                                                                    |
| `@t3tools/ft3-delegation`    | Политика делегирования: поиск секретов, решение по тексту входа, проекция производного текста, конверт прав дочернего инстанса                                  | `./server`                                                                                                                                                                                                                                                      | server (чистые функции)    | [Delegation secret boundary (S)](../internals/fork-boundary.md#delegation-secret-boundary-s), [Delegation permission envelope (S)](../internals/fork-boundary.md#delegation-permission-envelope-s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@t3tools/ft3-orchestration` | Запросы к делегированным задачам, выжимки по ходам, handoff, MCP-инструменты `task_*`, реактор выжимок                                                          | `./server`, `./reactor`                                                                                                                                                                                                                                         | server                     | [Серверная композиция ft3](../internals/fork-boundary.md#серверная-композиция-ft3), [Панель «Карточки/История»](../internals/fork-boundary.md#панель-карточкиистория-в-чате-и-координаторская-кнопка-в-шапке), [Delegation secret boundary](../internals/fork-boundary.md#delegation-secret-boundary-s)                                                                                                                                                                                                                                                                                                                                                                      |
| `@t3tools/ft3-pi`            | Управляемый agent-dir Pi, локальный llama-server, встроенный runtime, политика `ft3-local`, executor-only инстансы, Bonsai preset                               | `./server`, `./policy`, `./rpc-contracts`, `./rpc`                                                                                                                                                                                                              | server + контракты для web | [Pi: managed agent dir, local inference and executor-only instances](../internals/fork-boundary.md#pi-managed-agent-dir-local-inference-and-executor-only-instances-срез-1), [Pi: локальные llama-модели без MCP-инструментов](../internals/fork-boundary.md#pi-локальные-llama-модели-без-mcp-инструментов), [Pi Bonsai preset](../internals/fork-boundary.md#pi-bonsai-preset)                                                                                                                                                                                                                                                                                             |
| `@t3tools/ft3-kimi`          | Обёртка ACP-драйвера Kimi: лимиты плана, чтение usage из `wire.jsonl`, идентичность провайдера, ошибка исчерпанной квоты в успешном ходе                        | `./server`                                                                                                                                                                                                                                                      | server                     | [Kimi usage limits (S)](../internals/fork-boundary.md#kimi-usage-limits-s), [Kimi usage provider and provider visibility](../internals/fork-boundary.md#kimi-usage-provider-and-provider-visibility), [Kimi quota failures inside a successful ACP turn](../internals/fork-boundary.md#kimi-quota-failures-inside-a-successful-acp-turn)                                                                                                                                                                                                                                                                                                                                     |
| `@t3tools/ft3-vcs`           | История коммитов, список refs, дифф коммита, резолв commit-упоминаний в чате                                                                                    | `./rpc`, `./service`, `./contracts`, `./rpc-contracts`                                                                                                                                                                                                          | server + контракты для web | [Граф коммитов (S2)](../internals/fork-boundary.md#граф-коммитов-срез-s2), [Выбор коммита в графе (S2b)](../internals/fork-boundary.md#выбор-коммита-в-графе-s2b), [Chat text chips and Typora](../internals/fork-boundary.md#chat-text-chips-and-typora)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@t3tools/ft3-web`           | Web-расширение: реестр поверхностей правой панели, доска, архитектор, делегирование, sidebar-лес, чат-чипы, граф коммитов, usage, настройки, Pi/Kimi UI         | `./panels`, `./chat`, `./chat-composer`, `./chat-copy`, `./files`, `./settings`, `./settings-search`, `./board`, `./board-chat`, `./board-header`, `./commits`, `./architect`, `./pi`, `./sidebar`, `./usage`, `./kimi`, `./delegation`, `./delegation-dialogs` | web                        | [Web extensions (S3)](../internals/fork-boundary.md#web-extensions-s3), [Architect sidebar and human publication (S4)](../internals/fork-boundary.md#architect-sidebar-and-human-publication-s4), [Sidebar: лес делегирования](../internals/fork-boundary.md#sidebar-лес-делегирования-роль-бейджи-и-пин-архитектора-порт-старого-форка), [Usage page](../internals/fork-boundary.md#usage-page-model-columns-sorting-and-per-session-cost-s), [Markdown frontmatter in document previews](../internals/fork-boundary.md#markdown-frontmatter-in-document-previews), [Меню треда](../internals/fork-boundary.md#меню-треда-делегирование-смена-провайдера-и-каскад-потомков) |

## Как части говорят

### Сервер: Effect-слои

`@t3tools/ft3-host/server` — композиционный корень:

- `layer` — `BoardRepository.layer`, от которого зависят серверные сервисы доски;
- `mcpToolkits` — массив Layer'ов регистрации MCP-toolkit'ов;
- `reactorLayer()` — Layer со всеми реакторами форка;
- `runMigrations` — прогон `ft3_migrations`.

Upstream подключает корень тремя аддитивными швами: `apps/server/src/server.ts` добавляет
`Ft3Host.layer` и `Ft3Host.reactorLayer()` в общую композицию,
`apps/server/src/mcp/McpHttpServer.ts` расширяет `Layer.mergeAll` через
`...Ft3Host.mcpToolkits`, а `apps/server/src/persistence/Sqlite.ts` вызывает
`Ft3Host.runMigrations()` после core-миграций. Все три места перечислены в
[«Серверная композиция ft3»](../internals/fork-boundary.md#серверная-композиция-ft3).

MCP-toolkit'ы строятся через штатные `toolkitRegistration`/`McpToolAccess` и грузятся
лениво (`Effect.promise(() => import(...))`), чтобы не замкнуть инициализацию модулей
сервера. Права проверяются при каждом вызове: capability `orchestration`, живой тред,
принадлежность карточки или связки.

### ft3 RPC в WebSocket

Контракты методов лежат в `rpc-contracts` каждого пакета и собираются в
`@t3tools/ft3-host/rpc-contracts` (браузерный вход). Серверная группа
`@t3tools/ft3-host/rpc` добавляет обработчики, карту scope и `serviceLayer`.

`apps/server/src/ws.ts` делает только `WsRpcGroup.merge(Ft3Rpc.group)`, spread
`Ft3Rpc.handlers`, `Ft3Rpc.authorizationLayer` и `Ft3Rpc.serviceLayer`; upstream-карта прав
не правится. Web подключает контракты через `packages/client-runtime/src/rpc/protocol.ts`.
Права: чтение доски, архитектора, VCS, статуса Pi и документов OpenContext —
`orchestration:read`; запись, запуск Pi и публикация — `orchestration:operate`. См.
[«RPC-модуль ft3 для web (S1)»](../internals/fork-boundary.md#rpc-модуль-ft3-для-web-срез-s1)
и [«Web extensions (S3)»](../internals/fork-boundary.md#web-extensions-s3).

### Реакторы

`Ft3Host.reactorLayer()` сливает четыре `layerWorker()`:

- `@t3tools/ft3-board/reactor` — `BoardReactor`: `thread.deleted` и terminal-события
  исполнителей, курсор и очередь пробуждений;
- `@t3tools/ft3-board/automation` — retention, nudge и purge удалённых тредов;
- `@t3tools/ft3-architect/reactor` — `ArchitectReconciler` после рестарта;
- `@t3tools/ft3-orchestration/reactor` — `DelegatedTaskSummaryReactor` по terminal
  `provider-turn.updated`.

### Миграции

`packages/ft3-host/src/Migrations.ts` собирает миграции пакетов в один loader и пишет их в
журнал `ft3_migrations`. Package-миграции объявлены в `ft3-board/src/migrations.ts` и
`ft3-architect/src/migrations.ts`; host-миграции лежат в
`packages/ft3-host/src/Migrations/`. Подробности — в [database.md](./database.md).

### Web: реестры и швы

- Правая панель: `ft3-web/src/panels.tsx` — `Ft3Surface`, `ft3SurfaceRegistry`
  (`board`, `commits`), `normalizeFt3Surface`, `Ft3SurfaceContent`. Upstream хранит только
  ветку union `ft3` и действие открытия.
- Sidebar: `ft3-web/src/sidebar` — `useFt3SidebarRows`, лес делегирования, role badges,
  пин архитектора, действия дочерних тредов.
- Чат: `ft3-web/src/chat` — `useFt3ChatTextExtensions`, чипы карточек/коммитов/документов,
  фильтры копирования; `ComposerFt3Actions` — слот действий composer'а.
- Доска: `ft3-web/src/board` — страница `/board`, `BoardPanel` для правой панели,
  `BoardChatSidePanel`, действия координатора в шапке.
- Архитектор: `ft3-web/src/architect` и `ArchitectSidebarPin`.
- Делегирование: `ft3-web/src/delegation` — меню треда, смена провайдера, каскад archive/delete,
  диалоги.

## Типовые задачи

| Задача                        | Где искать                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Доска, карточки, координаторы | `packages/ft3-board/src` (`BoardService`, `BoardRepository`, `BoardReactor`, `tools`, `contracts`), web — `packages/ft3-web/src/board`                                                                                  |
| Архитектор и ревью            | `packages/ft3-architect/src` (`ArchitectService`, `ArchitectRepository`, `ArchitectReconciler`, `tools`), web — `packages/ft3-web/src/architect`, `sidebar/ArchitectSidebarPin.tsx`                                     |
| Делегирование и секреты       | `packages/ft3-delegation/src` (`secretTextPolicy`, `delegationTextDecision`, `delegationPermissionEnvelope`); швы — `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts` |
| Запросы к задачам и выжимки   | `packages/ft3-orchestration/src` (`TaskQueryService`, `TaskHandoffService`, `DelegatedTaskSummaryReactor`, `DelegatedTaskSummaryRepository`)                                                                            |
| Pi и локальный llama-server   | `packages/ft3-pi/src` (`driver`, `agentDir`, `piRuntime`, `inferenceServer`, `localLlamaExtension`, `executorOnly`, `control`), web — `packages/ft3-web/src/pi`                                                         |
| Kimi                          | `packages/ft3-kimi/src` (`driver`, `usage`, `usageLimits`, `promptFailure`), web — `packages/ft3-web/src/kimi`, `ft3-web/src/usage`                                                                                     |
| VCS и граф коммитов           | `packages/ft3-vcs/src/CommitHistoryService.ts`, web — `packages/ft3-web/src/commits`                                                                                                                                    |
| Usage                         | `packages/ft3-web/src/usage`; поле `sessions` — `packages/shared/src/usageMerge.ts`                                                                                                                                     |
| Чипы в чате                   | `packages/ft3-web/src/chat`; резолв коммитов — `ft3-vcs`; документы — `packages/ft3-host/src/openContextDocs.ts`                                                                                                        |
| Настройки                     | `packages/ft3-board/src/settings.ts`, `packages/ft3-web/src/settings`; namespace `ft3` — `packages/contracts/src/settings.ts`                                                                                           |
| Таблицы и legacy-импорт       | `packages/ft3-host/src/Migrations.ts`, `packages/ft3-host/src/Migrations/`, `packages/ft3-host/src/import`; см. [database.md](./database.md)                                                                            |

## Перед изменениями

Прочитайте [contributing.md](./contributing.md): границы швов, нумерация миграций, порядок
добавления RPC и обязательные проверки, включая live-проверку в запущенном инстансе.
