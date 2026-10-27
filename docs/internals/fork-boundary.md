# Fork boundary (ft3-v2)

Правило переезда на upstream V2: правки upstream-файлов минимальны, каждая только
подключает или настраивает, своей логики в upstream-файлах нет. Каждая правка
записывается в таблицу ниже.

Исключение для двух переносимых исправлений Muse описано в отдельной таблице
ниже: их логика остаётся в upstream-пакете провайдера, без копии адаптера в ft3.

Гейт: `.github/workflows/ft3-gate.yml` на Windows по push в `ft3/v2` и вручную гоняет typecheck и тесты `packages/ft3-*`, typecheck `apps/server`/`apps/web` и тесты правленых upstream-файлов из таблиц ниже.

Цель: desktop ft3-v2 работает одновременно со старым ft3 desktop и официальным
T3 Code без общих userData, single-instance lock, AppUserModelID и URL-схемы.
single-instance lock привязан к userData, поэтому отдельной правки не требует.

| Upstream-файл                                   | Правка                                                                                    | Зачем                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/desktop/src/app/DesktopUserData.ts`       | `directoryNameOverride()` читает `T3CODE_DESKTOP_USER_DATA_DIR`                           | изоляция Chromium-профиля от `t3code` (ft3) и `t3code-v2` (официальный T3) |
| `apps/desktop/src/electron/ElectronProtocol.ts` | `getDesktopScheme` и `registerDesktopSchemePrivilegesSync` читают `T3CODE_DESKTOP_SCHEME` | изоляция URL-схемы; регистрируется как privileged до `ready`               |

`DesktopConfig`/`DesktopEnvironment` не правятся: override читается на месте
использования, поэтому значение не проходит через Config и Environment.

Тестовые правки той же desktop-интеграции:

| Upstream-файл                                        | Правка                              | Зачем                                        |
| ---------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `apps/desktop/src/app/DesktopUserData.test.ts`       | тест имени каталога из env override | проверка изоляции userData                   |
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

`packages/ft3-orchestration` хранит per-turn summaries делегированных задач в
`ft3_delegated_task_summaries` (таблица и исторические записи импортёра) и
`ft3_delegated_task_summary_reactor_cursor`. `DelegatedTaskSummaryReactor`
подключается тем же `Ft3Host.reactorLayer()` и реагирует на terminal
`provider-turn.updated` дочернего subagent-треда: детерминированный fallback
пишется сразу, модель — через V2 `TextGeneration.generateCommitMessage` с
`textGenerationModelSelection` из `resolveProjectSettings`; lease, watermark,
stale, retry и fingerprint повторяют старый форк. `task_list`/`task_read`
отдают `summary`, `task_summary_history` — страницы записей. Правок upstream для
этого не требуется, кроме уже перечисленных подключений пакета.

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
`vcs.resolveCommitMentions` (тот же read-scope) отвечает на чат-чипы коммитов:
один `git cat-file --batch-check` на пачку кандидатов, сокращение резолвится
только при единственном совпадении префикса, остальное остаётся обычным текстом.

Web-вкладка «Commit graph» в реестре `ft3-web` переносит компоненты старого
форка (`CommitsGraph`, `webGitGraphAdapter`, `commitsGraphPreferences`,
`commitsGraphSelection`) на `@web-git-graph/web` с тем же патчем через
`patchedDependencies` в `pnpm-workspace.yaml`. Реф-бейджи страницы читаются из
`--decorate`-вывода `git log`, а полный список веток и тегов — из
`vcs.listRepositoryRefs` (`git for-each-ref`) и накладывается поверх страницы,
поэтому рефы за пределами загруженной страницы тоже рисуются.

| Файл                  | Правка                                                                | Зачем                                           |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm-workspace.yaml` | `"@web-git-graph/web@1.0.7": patches/@web-git-graph__web@1.0.7.patch` | применить патч темы/колонок, как в старом форке |

## Выбор коммита в графе (S2b)

Клик по узлу графа выбирает коммит в штатной панели диффа V2. Логика выбора
живёт в `ft3-web` (`commitsPanel.logic.ts`), а `CommitsGraph` получает
`focusCommitId` из того же выбора, поэтому выбранный коммит подсвечен при
возврате к графу. Патч коммита читает `vcs.getCommitDiff` (`git diff` против
первого родителя, для корневого коммита — `git diff-tree --root`), а рендер
остаётся в `ft3-web` на существующих компонентах диффа V2. Открытие панели
диффа не сбрасывает этот выбор: `ChatView` вызывает
`prepareDiffSelectionForPanelOpen` из `ft3-web/commits`, который оставляет
`{ kind: "commit" }` и переводит на branch-дифф только остальные выборы.

| Upstream-файл                           | Правка                                                                                             | Зачем                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/web/src/diffPanelStore.ts`        | вариант `{ kind: "commit"; commitId }` и `selectCommit`                                            | хранить выбранный коммит рядом с остальными диффами  |
| `apps/web/src/components/DiffPanel.tsx` | `diffPanelCommitView` из `@t3tools/ft3-web/commits`; ранний возврат для выбранного коммита         | показать дифф коммита в штатной панели, без копии UI |
| `apps/web/src/components/ChatView.tsx`  | `prepareDiffSelectionForPanelOpen` из `@t3tools/ft3-web/commits` вместо `selectGitScope("branch")` | не затирать выбор коммита из графа                   |
| `packages/ft3-web/package.json`         | экспорт `./commits` → `./src/commits/index.ts`                                                     | точка подключения видов диффа и выбора из графа      |

## Pi: managed agent dir, local inference and executor-only instances (срез 1)

`packages/ft3-pi` оборачивает upstream `PiDriver`: в `create()` он пишет управляемый
agent-dir (`<stateDir>/pi/<instanceId>/agent`) с `models.json` (`ft3-local/*`,
`http://127.0.0.1:11434/v1` по умолчанию) и `settings.json` (пиннинг tools по
режиму хода, `defaultProjectTrust: never`), затем ставит `PI_CODING_AGENT_DIR` в env
инстанса и передаёт его в upstream. `settings.json` переписывается под режим
сессии до открытия Pi-процесса и под режим хода перед каждым ходом (и compaction).
`ensureReady(model)` берёт профиль llama-server из `inference-profiles.json` рядом с
agent-dir (или `T3CODE_FT3_PI_INFERENCE_CONFIG`), поднимает один процесс на endpoint,
ждёт `/health` и `/v1/models`. Слоты запросов перенесены (`acquireRequestSlot`).
Ручной start/stop/status llama-server идёт через группу ft3 RPC, без правок
`ws.ts`: `packages/ft3-pi` объявляет контракты в `rpc-contracts`, `ft3-host`
сливает их в свою группу, а `ft3-web` показывает статус и кнопку в composer для
выбранного Pi-инстанса. Статус и запуск используют конфиг, который драйвер
зарегистрировал при создании инстанса (`registeredConfig`); процесс
останавливается только по сохранённому `ChildProcess`, без поиска по имени.
Импорт Codex-skills и блокировка launch-env (`NODE_*`, proxy, `PI_*`) не
перенесены: upstream адаптер всегда досмешивает ambient env. Профили с `baseUrl`
вне loopback и `.ps1` launchers отклоняются, а не запускаются.

Встроенный runtime Pi перенесён в `packages/ft3-pi/src/piRuntime.ts`: пустой
`binaryPath` или `"pi"` считается sentinel и резолвится в
`@earendil-works/pi-coding-agent@0.87.1` (`dist/bundle/cli.js`, зависимость
`ft3-pi`), который запускается текущим Node-исполняемым файлом через
сгенерированный launcher `<stateDir>/pi/<instanceId>/runtime/pi[.cmd]`. Поиск
идёт вверх по дереву каталогов от модуля, чего достаточно для workspace/dev.
Упакованный sidecar этот пакет на диск не кладёт: серверный бандл инлайнит
workspace-зависимости, поэтому packaged runtime потребует отдельного
packaging-шага и пока не покрыт. Явный непустой `binaryPath`, отличный от `"pi"`,
передаётся upstream без изменений; `PI_BUNDLED_PI_BIN` по-прежнему запрещён, а
отсутствие пакета — ошибка, а не fallback на PATH. Upstream-файлы не менялись:
правка только в `packages/ft3-pi`, его `package.json` и `pnpm-workspace.yaml`
(`allowBuilds: false` для `@google/genai` и `protobufjs`, пришедших с пакетом);
`pnpm-lock.yaml` фиксирует importer `packages/ft3-pi`.

`T3CODE_FT3_EXECUTOR_ONLY_INSTANCES` — список id инстансов через запятую; такие
инстансы не получают capability `orchestration` ни в MCP-credential, ни в наборе
`ProviderSessionManager`, поэтому не могут действовать как координатор.

| Upstream-файл                                                          | Правка                                                                                | Зачем                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/server/src/provider/builtInDrivers.ts:12-15`                     | импорт `Ft3PiDriver as PiDriver` из `@t3tools/ft3-pi/server`                          | подключить управляемый Pi вместо upstream-драйвера                    |
| `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1,429-437` | импорт и вычисление capability `orchestration` через `isExecutorOnlyProviderInstance` | не выдавать координаторские права исполнителю                         |
| `apps/server/src/mcp/McpSessionRegistry.ts:2,110-116`                  | импорт и то же условие вокруг `orchestration`                                         | registry выдаёт capability сам, поэтому одной правки в менеджере мало |
| `apps/server/package.json:44`                                          | зависимость `@t3tools/ft3-pi: workspace:*`                                            | разрешение workspace-пакета                                           |
| `pnpm-lock.yaml`                                                       | importer `packages/ft3-pi` и зависимость `apps/server`                                | воспроизводимое подключение                                           |

Ручное управление llama-server (срез S) добавляет три метода в ту же группу ft3
RPC (`pi.inferenceServer.status|start|stop`): статус читает
`orchestration:read`, запуск и остановка — `orchestration:operate`, как в старом
форке. Обработчики вызывают `makePiInferenceControl` из `ft3-pi` поверх
process-wide менеджера, поэтому `ws.ts` и карта прав upstream не меняются.

| Upstream-файл                                   | Правка                                                                                             | Зачем                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/web/src/components/chat/ChatComposer.tsx` | `ChatComposerFt3Actions` из `@t3tools/ft3-web/chat-composer`; один слот в ряду действий composer'а | start/stop и индикатор статуса llama-server в composer     |
| `pnpm-lock.yaml`                                | зависимости `@t3tools/ft3-pi` у `packages/ft3-host` и `packages/ft3-web`                           | браузерные контракты и серверная регистрация группы Pi RPC |

## Pi: локальные llama-модели без MCP-инструментов

`packages/ft3-pi/src/localLlamaExtension.ts` владеет политикой провайдера
`ft3-local`: активными остаются только восемь встроенных инструментов Pi, а
секция `t3_code_orchestration` не попадает в system prompt, потому что
llama.cpp не разбирает часть T3 MCP JSON-схем (например `summary.maxLength`).
При переключении на удалённого провайдера инструменты MCP возвращаются.
Upstream хранит только необязательный transform в mcpExtensionSource.ts; wrapper
импортирует хук напрямую и регистрирует его до материализации расширения.

| Upstream-файл                                           | Правка                                                     | Зачем                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| `packages/provider-pi/src/server/mcpExtensionSource.ts` | `setPiExtensionSourceTransform` и `piT3McpExtensionSource` | generic hook, политика остаётся в `ft3-pi`             |
| `packages/provider-pi/src/server/mcpInjection.ts`       | материализует `piT3McpExtensionSource()` вместо константы  | применить зарегистрированный transform                 |
| `packages/provider-pi/src/server/mcpBridge.testkit.ts`  | опции `source` и `provider` в контексте модели             | загрузка преобразованного расширения в тестах `ft3-pi` |

Тесты форка: `packages/ft3-pi/src/localLlamaExtension.test.ts`; upstream держит
только проверку самого хука в `mcpExtensionSource.test.ts`.

## Исправления Muse в стеке ft3

Перед успешным завершением адаптер сверяет потоковый текст с `session/read`:
восстанавливает только совместимые хвосты и отсутствующие сообщения. Полнота
подтверждается только непротиворечивой историей с завершёнными сообщениями;
ошибка чтения сохраняет результат как `unavailable`, не блокируя завершение.

В V2 не было поля полноты. Необязательный `outputStatus` в provider turn
сохраняется существующей проекцией и JSON-контрактом; отсутствие поля у других
провайдеров не означает подтверждённую полноту. Дополнительная SQL-миграция
не требуется. `providerTurnId` является id оркестратора, поэтому для interrupt
после потери in-memory active отдельно передаётся сохранённый native id.

| Upstream-файл                                                                     | Правка                                                                          | Зачем                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/provider-muse/src/server/adapter.ts`                                    | сверка истории перед terminal и fallback interrupt по native id                 | полнота текста и Stop после resume                                                          |
| `packages/provider-muse/src/server/protocol.ts`                                   | необязательный `history.mode`                                                   | отличать исключённую историю от полной                                                      |
| `packages/contracts/src/orchestrationV2.ts`                                       | необязательный `OrchestrationV2ProviderTurn.outputStatus`                       | сохранять `available` / `empty` / `unavailable` в результате хода                           |
| `packages/provider-core/src/server/ProviderAdapter.ts`                            | необязательный `ProviderAdapterV2InterruptInput.nativeTurnId`                   | передавать native identity без разбора внутренних id                                        |
| `apps/server/src/orchestration-v2/ProviderTurnControlService.ts`                  | native id из сохранённого turn в обоих interrupt-вызовах                        | fallback после потери состояния адаптера                                                    |
| `packages/provider-muse/src/server/adapter.test.ts`                               | регрессии восстановления текста, недостоверной истории и interrupt после resume | воспроизводимость обеих ошибок                                                              |
| `packages/contracts/src/orchestrationV2.test.ts`                                  | JSON round-trip с полем полноты и без него                                      | обратная совместимость результата                                                           |
| `apps/server/src/orchestration-v2/ProviderTurnControlService.test.ts`             | проверки передачи native id при Stop и restart                                  | доставка сохранённого native id                                                             |
| `apps/server/src/orchestration-v2/Adapters/MuseAdapterV2.testkit.ts`              | явная RPC-ошибка для незаписанного чтения истории                               | старые live-записи не подменяются выдуманной историей; записанные запросы остаются строгими |
| `apps/server/src/orchestration-v2/testkit/MuseReplayFixtures.integration.test.ts` | проверка `unavailable` в сохранённой проекции simple replay                     | полнота не выводится из одного terminal                                                     |

Две правки Muse — сверка истории в `provider-muse` и `history.mode` — это
исправление поведения самого провайдера, а не логика ft3: снаружи его не
применить, не скопировав адаптер, поэтому они остаются в upstream-пакете.
Кандидаты на удаление, когда upstream сам добавит полноту результата хода и
fallback interrupt по native id.

## Исправление Codex: не ждать закрытия пайпов

Перенос коммита `b92ce534ff` из старого форка. Генерация текста через Codex не
ждёт EOF stdout/stderr после выхода `codex exec`: helper (например `git clone` из
plugin marketplace) может держать унаследованные пайпы открытыми, поэтому EOF —
ненадёжный признак завершения вывода. Механика дренажа живёт в
`packages/ft3-host/src/processOutput.ts` (`drainProcessOutput`): потоки читаются
в фоне, ожидается только exit code, затем дренаж с ограниченным ожиданием
`CODEX_OUTPUT_DRAIN_MS`. При таймауте в ошибку добавляется хвост stderr.
Прерывание запроса убивает fixture-процесс, поэтому его TCP-соединение с
`processProbe` сбрасывается: сокет пробы глотает только `ECONNRESET`/`EPIPE`
после убийства, остальные ошибки пробрасывает.

| Upstream-файл                                                | Правка                                                                                                 | Зачем                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/server/src/textGeneration/CodexTextGeneration.ts`      | импорт `drainProcessOutput` из `@t3tools/ft3-host/process-output`; хвост stderr в сообщении о таймауте | генерация не зависает на открытых пайпах после выхода codex |
| `apps/server/src/textGeneration/CodexTextGeneration.test.ts` | регрессии с detached-helper, держащим stdio; проверка сообщения об ошибке                              | воспроизводит зависание и сохраняет сообщение об ошибке     |
| `apps/server/src/testUtils/processProbe.ts`                  | обработчик `error` на сокете пробы; регрессионный тест `processProbe.test.ts`                          | без него kill fixture-процесса даёт uncaught `ECONNRESET`   |

`processProbe.ts` — собственный баг upstream-тестовой утилиты, а не логика форка:
кандидат на удаление, когда upstream сам начнёт глотать сброс сокета.

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

## Architect sidebar and human publication (S4)

`packages/ft3-web/src/sidebar` owns the coordinator pin; `packages/ft3-web/src/architect`
owns the human publish menu and its RPC state. The pin reads the binding snapshot
for the coordinator row; the publish menu reads the snapshot for the Architect
thread itself, so neither needs binding state from upstream. Only an active binding
nests the Architect row, and only the bound Architect thread with unpublished
records shows Publish.

| Upstream file                                   | Connection                                                                                         | Reason                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/web/src/components/Sidebar.tsx`           | render the package-provided `afterRowByKey` entry from `useFt3SidebarRows`                         | nest the Architect under its coordinator through a generic row seam |
| `apps/web/src/components/LegacySidebar.tsx`     | render the package-provided `afterRowByKey` entry from `useFt3SidebarRows`                         | nest the Architect under its coordinator through a generic row seam |
| `apps/web/src/components/chat/ChatComposer.tsx` | `ChatComposerFt3Actions` из `@t3tools/ft3-web/chat-composer`; один слот в ряду действий composer'а | publish Architect advice from the composer                          |
| `pnpm-lock.yaml`                                | `@t3tools/ft3-architect` dependency of the `packages/ft3-web` importer                             | resolve the browser-safe architect contracts                        |

`packages/ft3-architect/package.json` exports `./contracts` for those types; the
web extension must not import the server `./rpc` entry. Publication idempotency
keys are generated in `ft3-web`, while scope, binding and publication state stay
server-authoritative. The old pin's provider picker is not transferred: Replace
writes a reason-backed replace request into the coordinator's composer draft and
lets the Coordinator apply it under the routing policy.

## Delegation secret boundary (S)

`packages/ft3-delegation` owns the secret scanner, the delegation input decision and the derived-text projection. `packages/ft3-board/authorTextPolicy` re-exports it.

| Upstream file                                      | Connection                                                                                                                                                                                                                                       | Reason                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `apps/server/src/mcp/OrchestratorMcpService.ts`    | import `delegationTextDecision`/`projectDerivedText`; deny secret-bearing `delegate_task` input and `t3_thread_send` follow-ups to delegated children with `capability_denied`; project `summary`, `latestTerminalSummary` and `readThread` text | keep credentials out of delegated task text and agent reads                      |
| `apps/server/src/orchestration-v2/Orchestrator.ts` | import `projectDerivedText`; project `task.result` in `delegatedCompletionWakeDetail`                                                                                                                                                            | keep the parent wake free of credentials while the canonical result stays intact |
| `apps/server/package.json`                         | add `@t3tools/ft3-delegation`                                                                                                                                                                                                                    | resolve the workspace package                                                    |
| `pnpm-lock.yaml`                                   | importer `packages/ft3-delegation` and the `apps/server` dependency                                                                                                                                                                              | record the workspace link                                                        |

New fork-owned tests: `apps/server/src/mcp/OrchestratorMcpService.delegationText.test.ts` and `apps/server/src/orchestration-v2/Ft3DelegationWakeText.test.ts`.

The same policy covers the fork-owned task surface: `ft3-orchestration/TaskQueryService` projects `task_read` message, activity and payload strings and `task_list`/`task_search` titles, and `ft3-orchestration/TaskHandoffService` rejects a credential-bearing handoff before it is stored.

## Delegation permission envelope (S)

`packages/ft3-delegation` also owns the delegation permission envelope. Upstream
V2 already places every child in the parent's project (`makeSubagentChildThread`),
inherits the parent checkout unless `isolation: "worktree"` creates one from the
project root, and refuses child runtime/interaction modes ranked above the parent
(`resolveRuntimeMode`/`resolveInteractionMode`). The envelope adds only what
those checks cannot see: provider instance configuration (launch arguments,
OpenCode config content, driver-prefixed security environment variables) that
makes the effective authority broader than the declared runtime mode. The
boundary is the parent project, not the parent worktree, so worktree delegation
stays allowed.

| Upstream file                                   | Connection                                                                                                                       | Reason                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/server/src/mcp/OrchestratorMcpService.ts` | import `delegationPermissionDenial`; read settings and call it once before dispatch, then fail with the returned `code`/`reason` | refuse a child whose provider configuration outranks the parent envelope |

New fork-owned tests: `packages/ft3-delegation/src/delegationPermissionEnvelope.test.ts` and `apps/server/src/mcp/OrchestratorMcpService.delegationEnvelope.test.ts`.

## Kimi usage limits (S)

`packages/ft3-kimi` оборачивает upstream `AcpRegistryDriver`, сохраняя его
`driverKind` (`acpRegistry`), и добавляет только чтение plan usage Kimi Code.
ACP не отдаёт квоты, поэтому wrapper читает OAuth-токен CLI из
`~/.kimi-code/credentials/` (слот вычисляется так же, как в `kimi login`),
обновляет его через `{oauthHost}/api/oauth/token` с записью обратно в тот же
файл (tmp + rename, та же wire-форма) и запрашивает `GET {baseUrl}/usages`.
Лимиты прикрепляются к snapshot только для Kimi-инстанса: registry-агент
`kimi` или local-команда с именем `kimi`; остальные ACP-инстансы проходят без
изменений. Кэш лимитов — 60 секунд, `refresh` форсирует новый запрос.
Пакет не содержит исполняемого файла: используется `commandPath` инстанса.

| Upstream-файл                                | Правка                                                                                             | Зачем                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/server/src/provider/builtInDrivers.ts` | импорт `Ft3KimiDriver as AcpRegistryDriver` из `@t3tools/ft3-kimi/server` вместо registry-драйвера | добавляет usage limits Kimi без нового provider kind и правок web |
| `apps/server/package.json`                   | зависимость `@t3tools/ft3-kimi: workspace:*`                                                       | разрешает workspace-пакет                                         |
| `pnpm-lock.yaml`                             | importer `packages/ft3-kimi` и зависимость `apps/server`                                           | фиксирует workspace-связи                                         |

Новые тесты форка: `packages/ft3-kimi/src/usageLimits.test.ts` (мок HTTP и
временный файл credentials, реальный `~/.kimi-code` не читается) и
`packages/ft3-kimi/src/driver.test.ts`.

## Board: полная страница /board (порт UI старого форка)

`packages/ft3-web/src/board` владеет полной страницей доски, портированной из
старого форка (`apps/web/src/components/board/*` ветки
`feat/ocl-cross-provider-delegation`): `BoardPage` (шапка с Refresh / Add
Coordinator / Needs human, строка фильтров, чипы координаторов с счётчиками,
6 колонок `md:grid-cols-3 xl:grid-cols-6`, компактные карточки с клэмпом),`AddOrchestratorDialog`, `boardPreferences`, `useBoardBackend`, а также
`boardThreadActions.logic` / `useBoardThreadActions` /
`BoardThreadActionsControl` для сайдбара и шапки чата. Логика доски
(`board.logic`), диалоги карточек и иконки ролей перенесены ранее и
переиспользуются без изменений. Узкий `BoardPanel` в правой панели сохранён
как компактный вид (те же данные и фильтры, карточки в стиле полной доски,
кнопка «Open board» ведёт на `/board`). Данные идут через существующие
атомы `boardEnvironment` (`ft3-web/src/board/state.ts`) поверх RPC
`ft3-host`; отметка «новый чат» в `AddOrchestratorDialog` использует штатные
`threadEnvironment.create`/`startTurn` V2. Адаптации порта: фильтр
кандидатов читает `shell.lineage.parentThreadId` вместо старого
`delegationParent`, настройки пикера собираются из
`useEnvironmentSettings` + `resolveProjectSettings` (в V2 нет
`serverConfigs.providers` — провайдеры читаются через
`useEnvironmentProviders`). Панель делегированных-summary и граф коммитов —
отдельные поверхности, в страницу доски не входят.

| Upstream-файл                                       | Правка                                                                                                                          | Зачем                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/web/src/routes/board.tsx`                     | только опции маршрута: `beforeLoad`/`validateSearch`/`component` приходят из `@t3tools/ft3-web/board`, сам файл их не реализует | полная страница доска по `/board` и deep links `?orchestrator=&create=` |
| `apps/web/src/routeTree.gen.ts`                     | перегенерирован `@tanstack/router-generator` после добавления маршрута                                                          | регистрация `/board` в дереве маршрутов                                 |
| `apps/web/src/components/sidebar/SidebarChrome.tsx` | mount `useFt3SidebarBoardMenuItem`; pass its props to generic `SidebarUtilityItem`                                              | keep the Board item action and route in `ft3-web`                       |
| `packages/ft3-web/package.json`                     | экспорт `./board` → `./src/board/index.ts` (страница, компонент маршрута, guard и search)                                       | разрешение импорта страницы и опций маршрута из `apps/web`              |

Тесты форка: `packages/ft3-web/src/board/boardThreadActions.logic.test.ts`
(порт тестов логики действий координатора из старого форка; тесты `board.logic`
перенесены ранее). Поведение не перенесено: delegated-summary history в панели
и пин провайдера в диалоге архитектора — отдельные срезы.

## Usage page: model columns, sorting and per-session cost (S)

`packages/ft3-web/src/usage` owns the column picker, column persistence, sort
logic, the model table and the per-session formatter. Upstream `UsagePage` keeps
its own metric/window controls, provider filter, chart, totals and time
breakdown; it only mounts the table and formats two extra figures. V2 already
ships the pooled limits view (`UsageLimitsPooled` with `collectLimitPools`), so
the old fork's pooled component is not ported.

`packages/shared/src/usageMerge.ts` gains `ModelTotals.sessions`, summed from
bucket session counts. A session using several models or days counts under each,
because buckets do not carry session ids.

| Upstream file                                          | Connection                                                                                                                                     | Reason                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/web/src/components/usage/UsagePage.tsx`          | import `UsageModelTable`/`formatUsdPerSession`; mount the table in the model branch; append `$/session` to provider rows; add the average tile | keep columns, sorting and cost-per-session in `ft3-web` with a thin connection |
| `apps/web/src/components/usage/usageBreakdown.ts`      | remove `sortModelsByTokens`/`modelShare`                                                                                                       | model sorting and share now live in `ft3-web`                                  |
| `apps/web/src/components/usage/usageBreakdown.test.ts` | add `sessions` to the `ModelTotals` fixture                                                                                                    | follow the additive model field                                                |
| `packages/shared/src/usageMerge.ts`                    | add `ModelTotals.sessions` from bucket counts                                                                                                  | the field is a generic usage metric, so it stays next to the other totals      |
| `packages/shared/src/usageMerge.test.ts`               | assert per-model session sums                                                                                                                  | cover the new additive field                                                   |
| `packages/ft3-web/package.json`                        | export `./usage`                                                                                                                               | expose the extension entry                                                     |

New fork-owned tests: `packages/ft3-web/src/usage/*.test.ts` (including
`UsageModelTable.browser.test.tsx` and `usageProviders.test.ts`), not under
`apps/web`.

## Sidebar: лес делегирования, роль-бейджи и пин архитектора (порт старого форка)

`packages/ft3-web/src/sidebar` owns the fork-specific forest, family-root
selection, Architect nesting, role badges, working indicators, and delegated
child-thread actions. `useFt3SidebarRows` applies the forest transform
(`forest.logic.ts`: `orderSidebarSectionForest`, `filterCollapsedSidebarForest`,
`sidebarSubagentParentKey`/`sidebarForestParentKey`, and working/returned counts
from V2 `latestRun`/`runtime`), builds the role badge and collapse decorations,
provides the Architect row through `afterRowByKey`, and returns generic row props
and family roots. It also owns collapse state in localStorage, route-path expansion,
and orphan-subagent filtering. `familyRoots.ts` deduplicates roots; upstream keeps
only the generic `useThreadFamilies` mount hook in `state/threads.ts`.
`architectBindingIndex.ts` and `ArchitectSidebarPin.tsx` own Architect nesting;
`roleBadge.logic.ts`, `roleBadges.ts`, and `boardRoleIcons.tsx` own role badges
(data from the primary environment through `boardEnvironment`: orchestrators list
and cards by `executorThreadId`). `runFt3SidebarDelegatedAction` owns child archive,
delete, and stale-child cleanup orchestration. `useFt3SidebarBoardMenuItem` owns
the Board menu action. V2 child subagent threads carry `lineage.parentThreadId`
in the same environment as their parent, so the old cross-environment parent key
is not needed.

Upstream-правки — только подключение (каждая по одному вызову/пропу):

| Upstream-файл                                          | Правка                                                                                                                                                                                       | Зачем                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/web/src/components/Sidebar.tsx`                  | call `useFt3SidebarRows` once for sections/pool; consume row props and `afterRowByKey`; mount returned roots with `useThreadFamilies`; dispatch delegated actions through the package runner | keep forest, family roots, row decorations, Architect nesting, and child actions in `ft3-web` |
| `apps/web/src/components/LegacySidebar.tsx`            | call `useFt3SidebarRows` in `SidebarProjectItem`; consume row props and `afterRowByKey`; mount returned roots with `useThreadFamilies`                                                       | use the same package transform for the legacy sidebar                                         |
| `apps/web/src/components/sidebar/SidebarThreadRow.tsx` | accept generic `depth`, `decorations`, `metaDecorations`, and `statusOverride` props; render the status override through the existing row UI                                                 | keep the row extension seam small and generic                                                 |
| `apps/web/src/state/threads.ts`                        | keep generic `useThreadFamilies` mount; use `ThreadFamilyRoot` from `ft3-web`                                                                                                                | family root selection lives with the sidebar transform                                        |
| `apps/web/vite.config.ts`                              | алиас `@betteroffice/fonts-cjk` через `NodeURL.fileURLToPath` вместо `new URL(...).pathname`                                                                                                 | `pathname` оставляет `%20`, Node отклоняет путь с пробелом — падали все unit-тесты apps/web   |

`packages/ft3-web/src/sidebar/ArchitectSidebarPin.tsx` (пакет ft3-web,
не upstream): пин репортит активную связку в `architectBindingIndex` (лес
вкладывает реальный тред архитектора под координатора), принимает `depth`,
прячет Open/Replace при `architectShell.deletedAt != null` (показывает
«Deleted») и обновляет снапшот по сигнатуре списка тредов + updatedAt/deletedAt
архитектора, а не только по updatedAt координатора. Тесты порта —
`packages/ft3-web/src/sidebar/forest.logic.test.ts` и
`packages/ft3-web/src/sidebar/familyRoots.test.ts`.

## Board automation (retention, nudge, deleted-thread purge)

`packages/ft3-board` owns three V2 reactors started by `Ft3Host.reactorLayer()`:
`BoardRetentionReactor` archives old done cards and deletes archived done cards with a
deletion record, `CoordinatorBoardNudgeReactor` wakes an idle coordinator with its next
eligible card, and `DeletedThreadPurge` physically erases soft-deleted threads at server
start. V2 had no native deleted-thread erasure, so the purge covers `orchestration_v2_*`,
`ft3_board_*`, `ft3_architect_*`, delegated-summary, handoff, and scheduled-task rows.
Upstream `ServerSettings` (and its patch) carry one generic `ft3` namespace; the typed
schema, bounds, defaults and decoding live in `packages/ft3-board/src/settings.ts`
(`@t3tools/ft3-board/settings`). The reactors read the namespace through
`readBoardAutomationSettings`, and the UI sections write partial `{ ft3: { ... } }` patches
that the settings service deep-merges. The UI sections are ft3-web components mounted once
in General settings.

| Upstream file                                         | Connection                                                                                                                      | Reason                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/contracts/src/settings.ts`                  | add the generic `ft3` record to `ServerSettings` and `ServerSettingsPatch` (plus the fork's client `archiveThreadChildren` key) | keep one extension point in the existing settings service instead of a parallel store |
| `apps/web/src/components/settings/SettingsPanels.tsx` | import and render `Ft3GeneralSettingsSections` in General                                                                       | the only upstream mount for the ft3 settings UI                                       |
| `apps/web/src/components/settings/settingsSearch.ts`  | spread `FT3_SETTINGS_SEARCH_ITEMS` from `@t3tools/ft3-web/settings-search`                                                      | settings search must find the ft3 rows without touching core settings                 |
| `packages/ft3-host/src/server.ts`                     | merge `@t3tools/ft3-board/automation` into `reactorLayer()`                                                                     | start the three reactors beside the board, architect, and orchestration workers       |

New fork-owned tests: `packages/ft3-board/src/BoardRetentionReactor.test.ts`,
`CoordinatorBoardNudgeReactor.test.ts`, `DeletedThreadPurge.test.ts`, and
`packages/ft3-web/src/settings/*.browser.test.tsx`. Migration `9_BoardRetention` adds one
retention index and updates the migration-list expectations in ft3-host, ft3-board, and
ft3-architect.

## Pi Bonsai preset

`packages/ft3-pi` detects the Bonsai demo layout (`bin/cuda/llama-server.exe` plus
`models/bonsai2-gguf/27B/Ternary-Bonsai-2-27B-PQ2_0.gguf`) only from an explicit
`rootPath` or `BONSAI_DEMO_HOME`, and applies the preset into the instance's own
`inference-profiles.json` (the driver registers its path on instance creation). The
new `pi.bonsaiPreset.detect` and `pi.bonsaiPreset.apply` methods stay in the existing
ft3-pi RPC group; detect is `orchestration:read`, apply is `orchestration:operate`.
The settings UI lives in `packages/ft3-web/src/pi` and needs no new upstream contract.

| Upstream file                                                | Connection                                                                                            | Reason                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx` | import `PiBonsaiPresetSection` from `@t3tools/ft3-web/pi`; render it in `setup` for `driver === "pi"` | the only upstream mount for the Bonsai preset row |

New fork-owned tests: `packages/ft3-pi/src/inferenceServer.test.ts`,
`packages/ft3-pi/src/control.test.ts`, and
`packages/ft3-web/src/pi/PiBonsaiPresetSection.test.tsx`. They use fake `isFile`,
temporary config files, and command mocks; no llama-server or Pi process is spawned.

## Chat text chips and Typora

`packages/ft3-web/src/chat` owns board-card mention chips (`card-…`/UUID tokens
resolved through `board.resolve`), commit chips (7-40 hex tokens resolved through
`vcs.resolveCommitMentions`) and OpenContext document chips (`oc://doc/<id>` and
`ocl://doc/<id>`). One hook, `useFt3ChatTextExtensions`, supplies the remark
plugin, the chip renderer, and the extra allowed href schemes; upstream
`ChatMarkdown` only calls it and gives it two slots plus `cwd`, which names the
repository a commit SHA is resolved against. A chip click reuses the commit
graph selection path (`selectCommitFromGraph`): the diff panel opens on
`{ kind: "commit" }`, so the graph highlights the same commit. OpenContext
resolution is a new `openContext.resolveDoc` method in the existing ft3-host RPC
group, with the store snapshot scanner in
`packages/ft3-host/src/openContextDocs.ts` (the same package that already
composes the server RPC group), so no core contracts or `ws.ts` handler is
added. Commit SHAs resolve in `ft3-vcs` with one `git cat-file --batch-check`
call; unknown or ambiguous prefixes stay plain text. Typora joins the shared
editor list so the Markdown file preview can offer it, but it is filtered out of
every other open-with menu and never becomes the globally preferred editor.

| Upstream file                                        | Connection                                                                                                                                                                       | Reason                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/web/src/components/ChatMarkdown.tsx`           | import `useFt3ChatTextExtensions`; spread its remark plugins, pass its renderer, href predicate and `cwd` into `useChatMarkdownState`, and try the renderer in the anchor branch | one mount point for every chip kind without copying link logic             |
| `apps/web/src/components/Icons.tsx`                  | add `TyporaIcon`                                                                                                                                                                 | brand icon for the open-with row                                           |
| `apps/web/src/components/chat/OpenInPicker.tsx`      | `allowTypora` prop filters and prefers the editor; export `resolveOpenInOptions` for its test                                                                                    | Typora belongs to Markdown preview only                                    |
| `apps/web/src/editorPreferences.ts`                  | `resolvePreferredEditor(..., allowTypora)`; `usePreferredEditor` takes the flag                                                                                                  | a hidden editor must not be persisted as the default from another menu     |
| `apps/web/src/components/files/FilePreviewPanel.tsx` | pass `allowTypora={isMarkdown}`                                                                                                                                                  | the only surface that offers Typora                                        |
| `packages/contracts/src/editor.ts`                   | add the `typora` editor (`direct-path`)                                                                                                                                          | editor id crosses to the server launcher                                   |
| `packages/shared/src/editor.ts`                      | resolve the Typora executable from its install paths on Windows and macOS                                                                                                        | Typora is not on `PATH` and has no VS Code-style bundle layout             |
| `packages/shared/src/markdownPipeline.ts`            | allow the `oc` and `ocl` href protocols in the sanitize schema                                                                                                                   | sanitize runs before the anchor renderer and would strip the document link |
| `apps/web/src/markdown-clipboard.ts`                 | import the skip list, the anchor serializer and the rich-text chip exception from `@t3tools/ft3-web/chat-copy`                                                                   | chat copy filters stay fork-owned and tested                               |

Chat copy filters live in `packages/ft3-web/src/chat/chatCopyFilters.ts`: chrome
(`button`, `input`, `script`, `style`, `template`, `svg`, `aria-hidden`,
`select-none`, `sr-only`) is not copied, a chip's `data-markdown-copy` text wins
over its chrome in the plain-text flavor, chip buttons are removed from the
rich-text flavor except `chat-markdown-file-link`, and only `http(s)` anchors
keep their destination, so `oc://`/`ocl://`/fragment references copy as labels.
The filters match the old fork's chat copy behavior; a commit chip's label (the
SHA as typed) is its `data-markdown-copy`, so plain-text copy keeps the SHA and
rich-text copy drops the chip, while code blocks and the whole-message copy stay
unfiltered. Old fork source:
`apps/web/src/markdown-clipboard.ts`, `CommitMentionButton` in
`apps/web/src/components/ChatMarkdown.tsx`.

New fork-owned tests: `packages/ft3-web/src/chat/boardCardMentions.test.ts`,
`packages/ft3-web/src/chat/commitMentions.test.ts`,
`packages/ft3-web/src/chat/commitMentionsPlugin.test.ts`,
`packages/ft3-web/src/chat/CommitMentionChip.browser.test.tsx`,
`packages/ft3-web/src/chat/openContextDocLink.test.ts`,
`packages/ft3-web/src/chat/chatCopyFilters.test.ts`,
`packages/ft3-web/src/chat/chatCopyFilters.browser.test.tsx`,
`packages/ft3-host/src/openContextDocs.test.ts`, and
`packages/ft3-web/src/files/openInPicker.test.ts`.

## Markdown frontmatter in document previews

A leading YAML block in a Markdown file is metadata, not prose. Passing it to
the Markdown renderer turns the closing `---` into a setext heading and the
`key: value` lines into a paragraph. `packages/ft3-web/src/files` splits the
block off first and shows it as a monospaced block above the rendered body,
which keeps the old fork's presentation for OpenContext documents and every
other file opened in the files panel. Task-list offsets are shifted by the
block length so a checkbox edit still lands on the original file.

| Upstream file                                           | Connection                                                          | Reason                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/web/src/components/files/FileMarkdownPreview.tsx` | delegate to `MarkdownDocumentPreview` from `@t3tools/ft3-web/files` | frontmatter rendering stays in the fork package |
| `packages/ft3-web/package.json`                         | export `./files`                                                    | resolve the preview entry without a root barrel |

New fork-owned tests: `packages/ft3-web/src/files/markdownFrontmatter.test.ts`
and `packages/ft3-web/src/files/MarkdownDocumentPreview.browser.test.tsx`.

## Панель «Карточки/История» в чате и координаторская кнопка в шапке

`packages/ft3-web/src/board/BoardChatSidePanel.tsx` — порт плавающей панели
чата из старого форка (`apps/web/src/components/board-chat/BoardCardPinnedPanel.tsx`
ветки `feat/ocl-cross-provider-delegation`): вкладки «Карточки» и «История»
(вкладка «Коммиты» намеренно не переносится — граф коммитов остаётся в
поверхности правой панели), ресайз и сворачивание панели, закреплённые
карточки с действиями (старт/архив/просьба оркестратору) и постраничная
история выжимок с `IntersectionObserver`-sentinel'ем. Монтируется через хук
`useFt3BoardChatPanel(threadRef)` — null без server-треда.

История читает существующий сервис `task_summary_history`
(`packages/ft3-orchestration`) через новый метод ft3-RPC-группы
`board.delegatedTaskSummaryHistory` (read → `orchestration:read`): вход
`BoardDelegatedTaskSummaryHistoryInput` в `ft3-board/contracts`
(`parentThreadId` приходит из web, а не из MCP-области), результат —
существующий `TaskSummaryHistoryResult`. Обработчик идёт через новый
`BoardSummaryHistoryService` (`ft3-board`): обёртка над
`TaskQueryService.history` с синтетическим MCP-scope, как у
`BoardDelegationService` — иначе требование `TaskQueryService` утекло бы из
обработчика в ws-слой (handlers предоставляются `Ft3Rpc.serviceLayer`, а
сервис у неё внутренний). Веб-атом `delegatedTaskSummaryHistory` добавлен в
`ft3-web/src/board/backend.ts`; лоадер и маппинг записей — порты
`coordinatorSummaryHistory.ts`/`useCoordinatorSummaryHistoryLoader.ts` из
`board-chat` старого форка.

В шапку чата подключены уже перенесённые ранее `boardThreadActions.logic` /
`useBoardThreadActions` / `BoardThreadActionsControl`: меню «Coordinator
actions» (Make Coordinator / Create task / Resend brief / Remove) и бейдж
Coordinator с иконкой оркестратора. В контекстное меню треда старый форк
эти действия не добавлял — здесь тоже нет.

| Upstream file                                 | Connection                                                                                                                                           | Reason                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`        | импорт `useFt3BoardChatPanel`; вызов хука и рендер рядом с таймлайном; проп `hasDelegationParent` (`parentSubagentThreadId !== null`) в `ChatHeader` | панель в чате и данные для меню координатора                                                                                          |
| `apps/web/src/components/chat/ChatHeader.tsx` | импорт из `@t3tools/ft3-web/board-header`; два слота: `<CoordinatorBadge>` в хлебной крошке и `<ChatHeaderBoardActions>` в конце шапки               | координаторские действия в шапке, как в старом форке                                                                                  |
| `apps/web/src/state/use-atom-command.ts`      | раннер обёрнут в `useCallback` со стабильной идентичностью                                                                                           | портированная панель держит раннеры в зависимостях эффектов, как в старом форке; без мемоизации каждый рендер перезапускал бы эффекты |
| `apps/web/src/state/use-atom-query-runner.ts` | то же: `useCallback` вокруг раннера                                                                                                                  | то же, для query-раннера истории выжимок и карточек                                                                                   |
| `apps/server/src/ws.test.ts`                  | mock `BoardSummaryHistoryService` в обоих config-RPC слоях                                                                                           | RPC-слой требует новый ft3-сервис                                                                                                     |
| `packages/ft3-web/package.json`               | экспорты `./board-chat` и `./board-header`                                                                                                           | точки подключения панели и кнопок из upstream                                                                                         |

## Меню треда: делегирование, смена провайдера и каскад потомков

`packages/ft3-web/src/delegation` владеет всем, что меню треда делает сверх
upstream: `useSwitchThreadProvider` (нативный handoff через
`thread.update-metadata`), `useDelegationThreadActions` (`switch-provider`,
`archive-old-children`/`delete-old-children`, каскад archive/delete по
делегированным детям) и `DelegationDialogHosts` (диалог детей + диалог смены
провайдера, отдельный вход `./delegation-dialogs`, чтобы логика меню не тянула
UI в node-тесты). Upstream-хук меню оставляет только две точки подключения:
пункты вставляет `buildThreadActionMenuItems` через `buildSwitchProviderMenuItem`/
`buildOldChildrenMenuItems`, а выбранное действие уходит в
`delegation(action, thread, threadRef)` до upstream-`switch`. Для `archive` и
`delete` это перехватчик: он возвращает `true` только когда у треда есть
делегированные дети/потомки и каскад уже выполнен; без них возвращает `false`,
и работает upstream-ветка с её подтверждениями, текстами ошибок и
«thread archived, but navigation failed» без изменений. `ConfirmDialogHost`
остаётся upstream-файлом без правок.

| Upstream-файл                                       | Правка                                                                                                                                                                                                          | Зачем                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/src/hooks/useThreadActionMenu.ts`         | `canSwitchThreadProvider` + `selectStaleDelegatedChildren` для состояния меню; `useDelegationThreadActions(...)` и вызов его результата перед `switch`; upstream-ветки `archive`/`delete` сохранены байт-в-байт | меню только передаёт действие, каскад живёт в `ft3-web/delegation` |
| `apps/web/src/components/threadActionMenu.logic.ts` | `ThreadActionMenuId` включает `DelegationMenuItemId`; два поля состояния и два spread-вызова пунктов из `ft3-web`                                                                                               | пункты смены провайдера и чистки потомков собираются в пакете      |
| `apps/web/src/hooks/useSwitchThreadProvider.ts`     | файл стал однострочным ре-экспортом из `@t3tools/ft3-web/delegation`                                                                                                                                            | Sidebar и меню треда используют один хук из пакета                 |
| `apps/web/src/routes/__root.tsx`                    | `<DelegationDialogHosts />` из `@t3tools/ft3-web/delegation-dialogs` вместо `<SwitchProviderDialogHost />`                                                                                                      | одна точка монтирования диалогов делегирования                     |
| `packages/ft3-web/package.json`                     | экспорт `./delegation-dialogs` (хосты диалогов)                                                                                                                                                                 | вход логики меню не тянет UI-модули                                |

Тесты: логика каскада и диалогов покрыта существующими
`packages/ft3-web/src/delegation/delegatedChildren.logic.test.ts` и
`switchProviderDialog.logic.test.ts`; новый
`useDelegationThreadActions.test.ts` проверяет обе стороны перехватчика —
возврат `false` без детей и каскад с ними. В
`apps/web/src/hooks/useThreadActionMenu.test.ts` проверены оба пути
archive/delete: upstream-подтверждение без детей и каскадное поведение с ними.

## Kimi usage provider and provider visibility

Kimi instances run on the upstream `acpRegistry` driver, so the snapshot alone cannot name or price
them. `packages/ft3-kimi` now owns the Kimi identity (`displayName` "Kimi"), a scan usage reader over
`<KIMI_CODE_HOME or ~/.kimi-code>/sessions/**/wire.jsonl` `usage.record` lines, and the existing plan
limits. The usage page keeps a column for every provider whose scan reported a source, so a provider
with no events in the selected window (Codex after its last turn, OpenCode on a failed 90-day scan)
stays visible instead of vanishing when the range changes.

| Upstream file                                            | Connection                                                                                                                  | Reason                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/contracts/src/usage.ts`                        | add `"kimi"` to `UsageProviderKind`                                                                                         | carry Kimi buckets through the usage contract                              |
| `apps/server/src/provider/builtInDrivers.ts`             | `AcpRegistryDriver` joins `BUILT_IN_USAGE_DRIVERS` and `BuiltInUsageReadersEnv`                                             | run the Kimi scan reader beside the other usage readers                    |
| `apps/web/src/components/usage/usageProviders.ts`        | add only the `kimi` presentation entry                                                                                      | the presentation map is exhaustive over the contract                       |
| `apps/web/src/components/usage/UsagePage.tsx`            | build the active provider set from `providersForWindow` (imported from `@t3tools/ft3-web/usage`) and the summaries' sources | a zero-usage or failed provider must not disappear with the selected range |
| `apps/web/src/components/chat/ProviderInstanceIcon.tsx`  | import `KimiIcon`/`isKimiProviderInstance` from `@t3tools/ft3-web/kimi`; the icon and the agent-id/name match live there    | the driver kind alone is generic ACP                                       |
| `apps/mobile/src/features/usage/usageProviders.ts`       | add kimi to the ordered kinds, labels and colors; local `poolDisplayName`                                                   | mobile has no ft3-web dependency; both pools need the instance name        |
| `packages/ft3-host/src/import/importProviderSettings.ts` | imported kimi instances get `displayName: "Kimi"`                                                                           | V1 named the provider, the ACP driver does not                             |
| `apps/web/src/components/usage/UsageLimitsPooled.tsx`    | section label falls back from `limitPoolDisplayName(pool)` (ft3-web) to the driver label                                    | the limits card says Kimi, not ACP Registry                                |
| `apps/mobile/src/features/usage/UsageLimitsPooled.tsx`   | the same fallback with the local helper, and the pool name is passed to `ProviderIcon`                                      | mobile limits match web                                                    |
| `apps/mobile/src/components/ProviderIcon.tsx`            | optional `displayName`; a Kimi ACP instance renders the Kimi glyph                                                          | mobile has no `ProviderInstanceIcon`                                       |

`KimiIcon`, `isKimiProviderInstance` and `limitPoolDisplayName` live in `packages/ft3-web`
(`/kimi` and `/usage`), so upstream `Icons.tsx` has no Kimi glyph and
`packages/shared/src/usageLimits.ts` is back to its upstream shape.

Fork-owned tests: `packages/ft3-kimi/src/usage.test.ts`,
`packages/ft3-web/src/usage/usageProviders.test.ts`,
`packages/ft3-web/src/usage/usageLimitsPool.test.ts`, and the updated
`packages/ft3-host/src/import/importProviderSettings.test.ts`.

## Kimi quota failures inside a successful ACP turn

Kimi Code CLI 2.3.2 reports an exhausted 5-hour quota as a successful
`session/prompt` result with `stopReason: "end_turn"` and no content; the real
`APIProviderQuotaExhaustedError` only reaches Kimi's own `wire.jsonl`. The
upstream ACP adapter therefore records a completed empty turn. `packages/ft3-kimi`
now decorates the Kimi runtime: if an `end_turn` produced no message, thought,
tool, plan, or compaction update, it reads the plan usage endpoint and fails the
prompt with `Kimi: 5-hour limit exhausted, resets in …`. ACP has no extension
point for this, so the registry adapter accepts one optional runtime decorator.

| Upstream file                                          | Connection                                                                           | Reason                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/provider-acp-registry/src/server/adapter.ts` | `decorateRuntime` option is applied after `AcpSessionRuntime.layer` is built         | Kimi-specific turn settlement lives in the fork package               |
| `packages/provider-acp-registry/src/server/driver.ts`  | `AcpRegistryDriver.create` takes an optional second options argument and forwards it | `packages/ft3-kimi` creates the driver directly                       |
| `packages/provider-acp-registry/src/server.ts`         | re-exports the runtime service, ACP update/response types, and `makeAcpRequestError` | `ft3-kimi` does not depend on `provider-acp` or `effect-acp` directly |

New fork-owned tests: `packages/ft3-kimi/src/promptFailure.test.ts`.
