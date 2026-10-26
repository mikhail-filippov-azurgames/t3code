# Fork boundary (ft3-v2)

Правило переезда на upstream V2: правки upstream-файлов минимальны, каждая только
подключает или настраивает, своей логики в upstream-файлах нет. Каждая правка
записывается в таблицу ниже.

Цель: desktop ft3-v2 работает одновременно со старым ft3 desktop и официальным
T3 Code без общих userData, single-instance lock, AppUserModelID и URL-схемы.
single-instance lock привязан к userData, поэтому отдельной правки не требует.

| Upstream-файл                                   | Правка                                                                                    | Зачем                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/desktop/src/app/DesktopConfig.ts`         | `userDataDirectoryOverride: trimmedString("T3CODE_DESKTOP_USER_DATA_DIR")`                | env-переопределение имени userData                                         |
| `apps/desktop/src/app/DesktopEnvironment.ts`    | поле `userDataDirectoryOverride`, проброшено из `DesktopConfig`                           | доставка значения в `resolveUserDataPath`                                  |
| `apps/desktop/src/app/DesktopUserData.ts`       | `resolveUserDataPath` берёт `current` имя из override                                     | изоляция Chromium-профиля от `t3code` (ft3) и `t3code-v2` (официальный T3) |
| `apps/desktop/src/electron/ElectronProtocol.ts` | `getDesktopScheme` и `registerDesktopSchemePrivilegesSync` читают `T3CODE_DESKTOP_SCHEME` | изоляция URL-схемы; регистрируется как privileged до `ready`               |

Тестовые правки той же desktop-интеграции:

| Upstream-файл                                        | Правка                              | Зачем                                        |
| ---------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`    | тест передачи env override          | проверка конфигурации userData               |
| `apps/desktop/src/app/DesktopUserData.test.ts`       | тест имени каталога из override     | проверка изоляции userData                   |
| `apps/desktop/src/electron/ElectronProtocol.test.ts` | тесты override и fallback URL-схемы | проверка совместимости значений по умолчанию |

AppUserModelID переопределяется штатным env `T3CODE_DESKTOP_APP_USER_MODEL_ID`
(`apps/desktop/src/app/DesktopConfig.ts`), правки не требует.

## Значения для ft3-v2

| Компонент      | Старый ft3           | Официальный T3       | ft3-v2 (env)                                          |
| -------------- | -------------------- | -------------------- | ----------------------------------------------------- |
| userData       | `t3code`             | `t3code-v2`          | `T3CODE_DESKTOP_USER_DATA_DIR=ft3-v2`                 |
| AppUserModelID | `com.t3tools.t3code` | `com.t3tools.t3code` | `T3CODE_DESKTOP_APP_USER_MODEL_ID=com.t3tools.ft3.v2` |
| URL-схема      | `t3code`             | `t3code`             | `T3CODE_DESKTOP_SCHEME=ft3`                           |

Без env поведение совпадает с upstream.

## Серверная композиция ft3

`packages/ft3-host` владеет серверной композицией форка. Функциональные пакеты
подключаются через него; upstream-файлы только подключают его экспорты.
`packages/ft3-orchestration` читает V2-проекции без собственного движка и состояния.
Его MCP-регистрация использует существующие `McpToolAccess` и `toolkitRegistration`;
host загружает её при построении Layer, чтобы не замкнуть инициализацию модулей сервера.

| Upstream-файл                                       | Правка                                                                                      | Зачем                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/server/src/server.ts`                         | импорт `ft3-host/server`, `Ft3Host.layer` и `Ft3Host.reactorLayer()` в композиции Layer     | подключение серверных возможностей ft3, запуск реактора доски       |
| `apps/server/src/mcp/McpHttpServer.ts`              | импорт `ft3-host/server`, spread `Ft3Host.mcpToolkits` в `Layer.mergeAll`                   | подключение регистрационных Layer MCP-toolkit'ов ft3                |
| `apps/server/src/persistence/Sqlite.ts`             | импорт `ft3-host/server`, `Ft3Host.runMigrations()` после core `runMigrations()`            | миграции пакета на той же SQLite-сессии после core                  |
| `apps/server/package.json`                          | зависимость `@t3tools/ft3-host: workspace:*`                                                | разрешение workspace-пакета                                         |
| `pnpm-lock.yaml`                                    | importers `packages/ft3-*` и workspace-зависимости                                          | воспроизводимое подключение пакетов                                 |
| `apps/server/src/persistence/ft3Migrations.test.ts` | ожидаемые записи `Board`, `BoardReactor`, `Architect` и `ArchitectReviewWake` в журнале ft3 | проверка подключения миграций пакетов доски, реактора и архитектора |

Журнал пакета — `ft3_migrations`, таблицы пакета имеют префикс `ft3_`.
Core-журнал `effect_sql_migrations` принадлежит upstream; миграции ft3 его
не используют. Идентификаторы миграций в двух журналах независимы.

`packages/ft3-board` хранит доску отдельно от журнала событий V2. Репозиторий
принимает человеческую отметку оркестратора для будущего UI; MCP не
предоставляет инструмент назначения этой роли. Инструменты регистрируются для
всех сессий, а capability `orchestration`, актуальная человеческая отметка и
принадлежность карточки проверяются при каждом вызове. Это позволяет назначать
и снимать роль без перезапуска сессии. Внешний ключ отметки указывает на
`orchestration_v2_projection_threads`; логическое удаление V2 не запускает
SQL-каскад, поэтому `BoardReactor` (`packages/ft3-board/src/BoardReactor.ts`)
обрабатывает `thread.deleted` и явно удаляет карточки, историю и отметку
оркестратора. Он же будит оркестратора по terminal-событиям исполнителей
(`subagent.updated`, `run.updated`, `provider-thread.updated`,
`runtime-request.updated`), хранит курсор и очередь пробуждений в таблицах
`ft3_board_reactor_*` и подключается в рантайм через `Ft3Host.reactorLayer()`.

`packages/ft3-architect` хранит связку координатор/архитектор и запрошенные
архитектурные ревью отдельно от журнала событий V2. Таблицы
`ft3_architect_binding` и `ft3_architect_review` повторяют итоговую схему
legacy `coordinator_architect_binding`/`architecture_review` (миграции
058–061, 063 старого форка) с V2-владением: `coordinator_thread_id` ссылается
на `orchestration_v2_projection_threads` с каскадом, как отметка доски.
Срез 1–2 перенёс чтение (`get_coordinator_binding`, `list_architecture_reviews`);
срез 4 — создание/замену/отзыв связки; срез 5 — цикл ревью
(`architecture_review_request`, `architecture_review_answer`,
`architecture_review_cancel`). Отметка оркестратора не дублируется — проверка
при вызове читает `BoardRepository.listOrchestrators` из `ft3-board`. Права
повторяют `ft3-board`: capability `orchestration`, живой тред, отказ
делегированному исполнителю; доступ к данным — сам координатор (или человек
на нём) либо связанный архитектор только к своей связке.

Побудка архитектора доставляется штатным `message.dispatch` с
детерминированным `commandId` (`arch:review-wake:<reviewId>`), отметка
`request_wake_delivered_at` пишется после подтверждения (миграция
`5_ArchitectReviewWake`); повторная доставка идемпотентна по receipt, а
рестарт-гэп между вставкой ревью и побудкой закрывается той же отметкой.
Ответ (`architecture_review_answer`) сохраняет ответ и не будит координатора,
как в старом форке. Политика секретов `ft3-board/authorTextPolicy` применяется
к `question`, `summary`, `reason` (запрос/ответ/отмена) и к `reason` в
replace/detach. Срез 6 — публикация координатору: `prepare_coordinator_publication`
(архитектор готовит advice-запись `origin='architect-advice'` со статусом
`answered`, никогда не будит, повторная подготовка заменяет предыдущую) и
`publish_to_coordinator` (единственная побудка координатора за ревью,
детерминированный `commandId` `arch:publish-wake:<reviewId>`, отметка
`publish_delivered_at`; повтор не будит). Advice-запись публикует только
человек: серверный метод `publishHumanPublication` (`published_by='human'`,
как в миграции 063), который позже вызовет UI; попытка архитектора
опубликовать advice отклоняется как `human_publish_required`. Политика
секретов применяется и к тексту публикации (question/summary).

## RPC-модуль ft3 для web (срез S1)

WS RPC в V2 закрыт для пакетов, поэтому ft3 держит собственную группу
`@t3tools/ft3-host/rpc` (`RpcGroup.make(...boardRpcs, ...architectRpcs)` со своим
middleware `Ft3RpcScopeAuthorization`) и сливает её в серверную группу одной
строкой — `WsRpcGroup` и `RpcAuthorization.ts`/`clientRpcPermissions.ts` не
правятся. Права повторяют старый форк: доска и архитектор read →
`orchestration:read`, запись/публикация → `orchestration:operate`. Обработчики
вызывают сервисы `ft3-board`/`ft3-architect`; человек в web действует от своего
имени — отметка оркестратора и публикация человеком через
`publishHumanPublication`. Контракты методов (payload/success) перенесены из
старого форка; `vcs.listCommitHistory` в этот срез не входит — см. «Граф
коммитов (S2)».

| Upstream-файл                | Правка                                                                                                            | Зачем                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/server/src/ws.ts`      | `WsRpcGroup.merge(Ft3Rpc.group)`, spread `...Ft3Rpc.handlers`, `Ft3Rpc.authorizationLayer`, `Ft3Rpc.serviceLayer` | подключение группы, обработчиков, прав и сервисов ft3 |
| `apps/server/src/ws.test.ts` | mock `BoardService`/`ArchitectService` в config-RPC слое                                                          | серверный RPC-слой теперь требует ft3-сервисы         |

## Граф коммитов (срез S2)

`packages/ft3-vcs` владеет чтением истории коммитов. Контракты
`VcsCommitHistory*` перенесены из старого форка в `ft3-vcs/contracts` (в V2 их
нет — есть только `paginateBranches`). `CommitHistoryService` вызывает git через
тот же `VcsProcess`, что и `GitVcsDriver`, не правя `GitVcsDriverCore.ts`:
`git log` с `--decorate=full` и `--format`/`-z` (как в старом форке), исключает
внутренние checkpoint-рефы `refs/t3/checkpoints`, а `GitWorkflowService`-логика
нерепозиторного cwd воспроизведена проверкой `rev-parse --is-inside-work-tree`.
RPC-метод `vcs.listCommitHistory` (read → `orchestration:read`) добавляется в
группу ft3 теми же строками, что доска и архитектор — `ft3-host` лишь
импортирует `ft3-vcs/rpc` и сливает rpcs/handlers/scopes/serviceLayer. Права
`ws.ts`/`RpcAuthorization.ts` не правятся. Парсер и пагинация (`--skip`/`-n`,
локализация протухшего `offset` по `id`) покрыты тестами на моке `VcsProcess`.

Web-вкладка «Commit graph» в реестре `ft3-web` переносит компоненты старого
форка (`CommitsGraph`, `webGitGraphAdapter`, `commitsGraphPreferences`,
`commitsGraphSelection`) на `@web-git-graph/web` с тем же патчем через
`patchedDependencies` в `pnpm-workspace.yaml`. Реф-бейджи читаются только из
`--decorate`-вывода `git log`; дополнение рефами веток через `usePaginatedBranches`
не перенесено (у V2 `VcsRef` нет поля `target`).

| Файл                  | Правка                                                                | Зачем                                           |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm-workspace.yaml` | `"@web-git-graph/web@1.0.7": patches/@web-git-graph__web@1.0.7.patch` | применить патч темы/колонок, как в старом форке |

## Web extensions (S3)

`packages/ft3-web` owns the ft3 surface registry and Board UI. Upstream only
knows `kind: "ft3"` and `surfaceType`; titles, icons, availability, launch
actions, rendering and persisted ft3 surface validation belong to the registry.
New ft3 surface types need no additional upstream branches.

| Upstream file                                               | Connection                                                                                                                                                                                                                                     | Reason                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/web/src/rightPanelStore.ts`                           | import `Ft3Surface`/`normalizeFt3Surface`; add `"ft3"` to kinds and the surface union; exclude it from singleton operations; `openFt3Surface` delegates to existing `userAction`/`upsertSurface`; migration delegates to `normalizeFt3Surface` | preserve ft3 identity through normal panel storage and lifecycle        |
| `apps/web/src/components/RightPanelTabs.tsx`                | registry import; optional `threadRef`; select `openFt3Surface`; spread registry launch actions into the launcher and add menu; delegate title and icon                                                                                         | a single presentation hook for every ft3 surface                        |
| `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` | import and `case "ft3"` delegation to `Ft3SurfaceContent`                                                                                                                                                                                      | mount the registry component with the panel's thread and visibility     |
| `apps/web/src/components/ChatView.tsx`                      | pass the existing server `threadRef` to `ChatRightPanel`                                                                                                                                                                                       | scope launch actions to the actual panel, including remote environments |
| `apps/web/src/reopenClosedView.ts`                          | `case "ft3"` delegates to `openFt3Surface`                                                                                                                                                                                                     | reopen the exact surface type                                           |
| `apps/web/src/index.css`                                    | `@source "../../../packages/ft3-web/src"`                                                                                                                                                                                                      | include extension classes in Tailwind output                            |
| `apps/web/package.json`                                     | `@t3tools/ft3-web: workspace:*`                                                                                                                                                                                                                | resolve the extension package                                           |
| `packages/client-runtime/src/rpc/protocol.ts`               | import `@t3tools/ft3-host/rpc-contracts`; merge its group into `RpcClient.make`                                                                                                                                                                | reuse the existing authenticated environment WS session                 |
| `packages/client-runtime/package.json`                      | `@t3tools/ft3-host: workspace:*`                                                                                                                                                                                                               | resolve the browser-safe RPC entry                                      |
| `vite.config.ts`                                            | add `packages/ft3-web` to `TEST_CONFIG_PACKAGES`                                                                                                                                                                                               | route extension unit/browser tests to their own config                  |
| `pnpm-lock.yaml`                                            | workspace links for `apps/web`/`packages/client-runtime` and the `packages/ft3-web` importer                                                                                                                                                   | record dependencies using existing resolutions                          |

RPC definitions live in `ft3-board/rpc-contracts`, `ft3-architect/rpc-contracts`
and `ft3-host/rpc-contracts`. Server entries re-export those definitions and keep
their handlers and authorization layers. Web must import the contract entry:
the server `ft3-host/rpc` entry also loads repositories and services.

The extension uses the web host's `~` alias for existing V2 controls and state
hooks. Its typecheck includes the host web sources, which also supply router
type registration; this package is a web extension, not a standalone UI library.
Board reads refresh while observed, and writes invalidate the existing list
queries. Pinned cards use the original environment/thread storage keys and
bounded `board.resolve` requests. Coordinator requests use V2's normal message
dispatch. The old panel's delegated-summary history and commit graph are separate
features and are not part of this Board surface.
